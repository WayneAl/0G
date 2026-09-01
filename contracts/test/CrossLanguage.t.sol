// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {CollateralRegistry} from "../src/CollateralRegistry.sol";
import {StubVerifier} from "../src/StubVerifier.sol";
import {Verdict} from "../src/IProofVerifier.sol";

/// @notice Checks that a proof built by viem in packages/seal decodes here to the
/// same Verdict, and that the registry accepts it.
///
/// TypeScript signs the seal and Solidity verifies it. Nothing forces the two
/// encoders to agree; only crossing the boundary in a test does. Regenerate the
/// fixture with: pnpm --filter acu-seal gen-fixture
contract CrossLanguageTest is Test {
    using stdJson for string;

    string json;

    function setUp() public {
        json = vm.readFile("./test/fixtures/stub-proof.json");
    }

    function test_solidity_decodes_the_typescript_proof() public {
        address signer = json.readAddress(".signer");
        bytes memory proof = json.readBytes(".proof");

        StubVerifier verifier = new StubVerifier(signer);
        Verdict memory v = verifier.verify(proof);

        assertEq(v.subject, json.readBytes32(".expected.subject"), "subject");
        assertEq(v.action, uint8(json.readUint(".expected.action")), "action");
        assertEq(v.maxLtvBps, uint16(json.readUint(".expected.maxLtvBps")), "maxLtvBps");
        assertEq(v.expiresAt, uint64(json.readUint(".expected.expiresAt")), "expiresAt");
        assertEq(v.sealHash, json.readBytes32(".expected.sealHash"), "sealHash");
        assertEq(v.agentId, json.readUint(".expected.agentId"), "agentId");
        assertEq(v.delegationDepth, uint8(json.readUint(".expected.delegationDepth")), "delegationDepth");
    }

    function test_registry_lists_a_token_from_the_typescript_proof() public {
        address signer = json.readAddress(".signer");
        bytes memory proof = json.readBytes(".proof");
        address token = json.readAddress(".token");
        uint64 expiresAt = uint64(json.readUint(".expected.expiresAt"));

        StubVerifier verifier = new StubVerifier(signer);
        CollateralRegistry registry = new CollateralRegistry(address(verifier), address(this));

        vm.warp(expiresAt - 1 hours);
        registry.list(token, 7000, proof);

        (bool active, uint16 ltv, bytes32 sealHash,) = registry.listings(token);
        assertTrue(active);
        assertEq(ltv, 7000);
        // The on-chain record points back at the exact seal JSON Agent A signed.
        assertEq(sealHash, json.readBytes32(".sealADigest"), "sealHash must equal the seal A digest");
    }

    function test_the_attested_cap_still_binds_a_real_typescript_proof() public {
        StubVerifier verifier = new StubVerifier(json.readAddress(".signer"));
        CollateralRegistry registry = new CollateralRegistry(address(verifier), address(this));
        vm.warp(uint64(json.readUint(".expected.expiresAt")) - 1 hours);

        vm.expectRevert(CollateralRegistry.LTV_EXCEEDS_ATTESTED.selector);
        registry.list(json.readAddress(".token"), 7600, json.readBytes(".proof"));
    }
}
