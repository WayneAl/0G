// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {CollateralRegistry} from "../src/CollateralRegistry.sol";
import {StubVerifier} from "../src/StubVerifier.sol";
import {IProofVerifier, Verdict} from "../src/IProofVerifier.sol";

contract CollateralRegistryTest is Test {
    CollateralRegistry registry;
    StubVerifier verifier;

    uint256 constant AGENT_A_KEY = 0xA11CE;
    uint256 constant IMPOSTOR_KEY = 0xBAD;
    address agentA;
    address owner = address(0xDEAD);
    address token = address(0xCAFE);
    address otherToken = address(0xF00D);

    uint64 expiry;

    function setUp() public {
        agentA = vm.addr(AGENT_A_KEY);
        verifier = new StubVerifier(agentA);
        registry = new CollateralRegistry(address(verifier), owner);
        vm.warp(1_756_000_000);
        expiry = uint64(block.timestamp + 1 days);
    }

    function _verdict(address subject, uint8 action, uint16 maxLtv, uint64 exp)
        internal
        pure
        returns (Verdict memory)
    {
        return Verdict({
            subject: bytes32(uint256(uint160(subject))),
            action: action,
            maxLtvBps: maxLtv,
            expiresAt: exp,
            sealHash: keccak256("seal-a"),
            agentId: 1,
            delegationDepth: 1
        });
    }

    function _proof(Verdict memory v, uint256 key) internal pure returns (bytes memory) {
        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(keccak256(abi.encode(v)));
        (uint8 vv, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encode(v, abi.encodePacked(r, s, vv));
    }

    // --- happy path ---------------------------------------------------------

    function test_list_succeeds_within_attested_ltv() public {
        bytes memory proof = _proof(_verdict(token, 1, 7500, expiry), AGENT_A_KEY);
        registry.list(token, 7000, proof);

        (bool active, uint16 ltv, bytes32 sealHash, uint64 exp) = registry.listings(token);
        assertTrue(active);
        assertEq(ltv, 7000);
        assertEq(sealHash, keccak256("seal-a"));
        assertEq(exp, expiry);
        assertTrue(registry.isActive(token));
    }

    function test_list_allows_exactly_the_attested_cap() public {
        registry.list(token, 7500, _proof(_verdict(token, 1, 7500, expiry), AGENT_A_KEY));
        (, uint16 ltv,,) = registry.listings(token);
        assertEq(ltv, 7500);
    }

    // --- demo scene ② : the auditor said no ---------------------------------

    function test_revert_AUDIT_FAILED_when_seal_says_deny() public {
        bytes memory proof = _proof(_verdict(token, 0, 0, expiry), AGENT_A_KEY);
        vm.expectRevert(CollateralRegistry.AUDIT_FAILED.selector);
        registry.list(token, 5000, proof);
    }

    // --- demo scene ③ : replaying another token's seal -----------------------

    function test_revert_SEAL_SUBJECT_MISMATCH_on_replay() public {
        bytes memory proof = _proof(_verdict(otherToken, 1, 7500, expiry), AGENT_A_KEY);
        vm.expectRevert(CollateralRegistry.SEAL_SUBJECT_MISMATCH.selector);
        registry.list(token, 7000, proof);
    }

    // --- demo scene ④ : asking for more leverage than was attested ----------

    function test_revert_LTV_EXCEEDS_ATTESTED() public {
        bytes memory proof = _proof(_verdict(token, 1, 7500, expiry), AGENT_A_KEY);
        vm.expectRevert(CollateralRegistry.LTV_EXCEEDS_ATTESTED.selector);
        registry.list(token, 8000, proof);
    }

    // --- expiry -------------------------------------------------------------

    function test_revert_SEAL_EXPIRED() public {
        bytes memory proof = _proof(_verdict(token, 1, 7500, expiry), AGENT_A_KEY);
        vm.warp(expiry);
        vm.expectRevert(CollateralRegistry.SEAL_EXPIRED.selector);
        registry.list(token, 7000, proof);
    }

    function test_listing_stops_being_active_after_expiry() public {
        registry.list(token, 7000, _proof(_verdict(token, 1, 7500, expiry), AGENT_A_KEY));
        assertTrue(registry.isActive(token));
        vm.warp(expiry);
        assertFalse(registry.isActive(token));
    }

    // --- demo scene ⑤ : no seal at all --------------------------------------

    function test_revert_NO_SEAL_on_empty_proof() public {
        vm.expectRevert(StubVerifier.NO_SEAL.selector);
        registry.list(token, 7000, "");
    }

    function test_revert_NO_SEAL_on_truncated_proof() public {
        vm.expectRevert(StubVerifier.NO_SEAL.selector);
        registry.list(token, 7000, hex"deadbeef");
    }

    function test_revert_NO_SEAL_on_malformed_signature_length() public {
        Verdict memory v = _verdict(token, 1, 7500, expiry);
        vm.expectRevert(StubVerifier.NO_SEAL.selector);
        registry.list(token, 7000, abi.encode(v, hex"1234"));
    }

    // --- demo scene ⑥ : forged or tampered seals ----------------------------

    function test_revert_BAD_SIGNATURE_from_wrong_signer() public {
        bytes memory proof = _proof(_verdict(token, 1, 7500, expiry), IMPOSTOR_KEY);
        vm.expectRevert(StubVerifier.BAD_SIGNATURE.selector);
        registry.list(token, 7000, proof);
    }

    function test_revert_BAD_SIGNATURE_when_verdict_is_tampered_after_signing() public {
        Verdict memory v = _verdict(token, 0, 0, expiry);
        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(keccak256(abi.encode(v)));
        (uint8 vv, bytes32 r, bytes32 s) = vm.sign(AGENT_A_KEY, digest);

        // Flip DENY to ALLOW and raise the cap, keeping the original signature.
        v.action = 1;
        v.maxLtvBps = 9000;

        vm.expectRevert(StubVerifier.BAD_SIGNATURE.selector);
        registry.list(token, 9000, abi.encode(v, abi.encodePacked(r, s, vv)));
    }

    // --- verifier swap (spec §5.1) ------------------------------------------

    function test_setVerifier_only_owner() public {
        StubVerifier next = new StubVerifier(agentA);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        registry.setVerifier(address(next));
    }

    function test_setVerifier_swaps_proof_format_without_touching_listings() public {
        registry.list(token, 7000, _proof(_verdict(token, 1, 7500, expiry), AGENT_A_KEY));

        uint256 newKey = 0xC0FFEE;
        StubVerifier next = new StubVerifier(vm.addr(newKey));
        vm.prank(owner);
        registry.setVerifier(address(next));

        // The existing listing survives the swap.
        assertTrue(registry.isActive(token));
        // The old signer is no longer accepted.
        vm.expectRevert(StubVerifier.BAD_SIGNATURE.selector);
        registry.list(otherToken, 100, _proof(_verdict(otherToken, 1, 7500, expiry), AGENT_A_KEY));
        // The new one is.
        registry.list(otherToken, 100, _proof(_verdict(otherToken, 1, 7500, expiry), newKey));
        assertTrue(registry.isActive(otherToken));
    }

    function test_setVerifier_rejects_zero() public {
        vm.prank(owner);
        vm.expectRevert(CollateralRegistry.ZERO_ADDRESS.selector);
        registry.setVerifier(address(0));
    }

    function test_constructor_rejects_zero_verifier() public {
        vm.expectRevert(CollateralRegistry.ZERO_ADDRESS.selector);
        new CollateralRegistry(address(0), owner);
    }

    // --- the seal carries a cap, not a boolean (spec §4.2) ------------------

    function testFuzz_never_lists_above_the_attested_cap(uint16 requested, uint16 attested) public {
        vm.assume(attested <= 10_000 && requested <= 10_000);
        bytes memory proof = _proof(_verdict(token, 1, attested, expiry), AGENT_A_KEY);
        if (requested > attested) {
            vm.expectRevert(CollateralRegistry.LTV_EXCEEDS_ATTESTED.selector);
            registry.list(token, requested, proof);
        } else {
            registry.list(token, requested, proof);
            (, uint16 ltv,,) = registry.listings(token);
            assertLe(ltv, attested);
        }
    }
}
