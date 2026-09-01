// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IProofVerifier, Verdict} from "./IProofVerifier.sol";

/// @notice Collateral admission gated on an attested underwriting seal.
///
/// The contract does not judge the token. It enforces what the seal says: the
/// seal must be about this token, must say ALLOW, must not have expired, and
/// the caller may not claim more leverage than the seal attested. Spec §5.2.
contract CollateralRegistry is Ownable {
    IProofVerifier public verifier;

    struct Listing {
        bool active;
        uint16 ltvBps;
        bytes32 sealHash;
        uint64 expiresAt;
    }

    mapping(address => Listing) public listings;

    event Listed(address indexed token, uint16 ltvBps, bytes32 sealHash);
    event VerifierChanged(address indexed oldV, address indexed newV);

    error SEAL_SUBJECT_MISMATCH();
    error AUDIT_FAILED();
    error LTV_EXCEEDS_ATTESTED();
    error SEAL_EXPIRED();
    error ZERO_ADDRESS();

    constructor(address verifier_, address owner_) Ownable(owner_) {
        if (verifier_ == address(0)) revert ZERO_ADDRESS();
        verifier = IProofVerifier(verifier_);
        emit VerifierChanged(address(0), verifier_);
    }

    /// @notice Swap the proof format without touching listings. Spec §5.1.
    function setVerifier(address v) external onlyOwner {
        if (v == address(0)) revert ZERO_ADDRESS();
        address old = address(verifier);
        verifier = IProofVerifier(v);
        emit VerifierChanged(old, v);
    }

    /// @param ltvBps The leverage the caller wants. Capped by the seal, never above it.
    /// @param proof  The underwriting seal, in whatever format the current verifier reads.
    function list(address token, uint16 ltvBps, bytes calldata proof) external {
        // Reverts inside the verifier on a missing or malformed seal.
        Verdict memory v = verifier.verify(proof);

        if (v.subject != bytes32(uint256(uint160(token)))) revert SEAL_SUBJECT_MISMATCH();
        if (v.action != 1) revert AUDIT_FAILED();
        if (ltvBps > v.maxLtvBps) revert LTV_EXCEEDS_ATTESTED();
        if (block.timestamp >= v.expiresAt) revert SEAL_EXPIRED();

        listings[token] = Listing(true, ltvBps, v.sealHash, v.expiresAt);
        emit Listed(token, ltvBps, v.sealHash);
    }

    /// @notice A listing stops counting the moment its seal expires. Re-listing
    ///         requires a fresh audit — today's clean upgradeable contract is not
    ///         next week's.
    function isActive(address token) external view returns (bool) {
        Listing storage l = listings[token];
        return l.active && block.timestamp < l.expiresAt;
    }
}
