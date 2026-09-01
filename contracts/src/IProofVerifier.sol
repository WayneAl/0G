// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice What a seal asserts, flattened to what a contract can afford to check.
/// @dev Mirrored in TypeScript by `toVerdict` in packages/seal/src/onchain.ts.
struct Verdict {
    bytes32 subject;
    uint8 action; // 0 = DENY, 1 = ALLOW
    uint16 maxLtvBps;
    uint64 expiresAt;
    bytes32 sealHash;
    uint256 agentId; // Agentic ID of the issuer
    uint8 delegationDepth; // seal-chain depth; 1 for this project
}

/// @notice Isolates proof-format knowledge so the registry never has to change.
///
/// The X-Agent-Proof format is only revealed at the on-site workshop. Swapping
/// verifiers is a deploy plus one `setVerifier` call; `CollateralRegistry` is
/// untouched. Spec §5.1.
interface IProofVerifier {
    /// @dev Must revert on any failure. Returning `false` would let a caller
    ///      ignore it, and the whole point is that it cannot be ignored.
    function verify(bytes calldata proof) external view returns (Verdict memory);
}
