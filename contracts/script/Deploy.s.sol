// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {CollateralRegistry} from "../src/CollateralRegistry.sol";
import {StubVerifier} from "../src/StubVerifier.sol";
import {CleanUSD} from "../src/mocks/CleanUSD.sol";
import {TrapUSD} from "../src/mocks/TrapUSD.sol";
import {InjectionUSD} from "../src/mocks/InjectionUSD.sol";

/// @notice Deploys the registry, the pre-event verifier, and the three demo tokens.
///
///   forge script script/Deploy.s.sol --rpc-url og_testnet --broadcast
///
/// Reads DEPLOYER_KEY and AGENT_A_ADDRESS from the environment. Burner keys only --
/// never a key that holds anything (spec §6.5).
contract Deploy is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_KEY");
        address agentA = vm.envAddress("AGENT_A_ADDRESS");
        address deployer = vm.addr(deployerKey);

        vm.startBroadcast(deployerKey);

        // The verifier trusts Agent A's seal signer, not the deployer.
        StubVerifier verifier = new StubVerifier(agentA);
        CollateralRegistry registry = new CollateralRegistry(address(verifier), deployer);

        CleanUSD clean = new CleanUSD(deployer);
        TrapUSD trap = new TrapUSD(deployer);
        InjectionUSD injection = new InjectionUSD(deployer);

        vm.stopBroadcast();

        console.log("CollateralRegistry", address(registry));
        console.log("StubVerifier      ", address(verifier));
        console.log("  seal signer     ", agentA);
        console.log("CleanUSD          ", address(clean));
        console.log("TrapUSD           ", address(trap));
        console.log("InjectionUSD      ", address(injection));
    }
}
