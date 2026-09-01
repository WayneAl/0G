// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {IProofVerifier, Verdict} from "./IProofVerifier.sol";

/// @notice Pre-event verifier: an ECDSA signature over the ABI-encoded Verdict.
///
/// Stands in for the real X-Agent-Proof verifier so the whole flow can be built
/// and demoed before the format is known. Spec §5.1.
contract StubVerifier is IProofVerifier {
    /// @notice The Agentic ID signer whose seals this verifier accepts.
    address public immutable signer;

    /// @dev Distinguishable as NO_SEAL: empty or undecodable proof bytes.
    error NO_SEAL();
    error BAD_SIGNATURE();

    constructor(address signer_) {
        require(signer_ != address(0), "signer=0");
        signer = signer_;
    }

    /// @inheritdoc IProofVerifier
    function verify(bytes calldata proof) external view returns (Verdict memory) {
        // A Verdict is 7 static words and the signature adds an offset word plus
        // a length word, so anything shorter cannot be a proof at all.
        if (proof.length < 32 * 9) revert NO_SEAL();

        (Verdict memory v, bytes memory signature) = abi.decode(proof, (Verdict, bytes));
        if (signature.length != 65) revert NO_SEAL();

        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(keccak256(abi.encode(v)));
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, signature);
        if (err != ECDSA.RecoverError.NoError || recovered != signer) revert BAD_SIGNATURE();

        return v;
    }
}
