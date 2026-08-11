// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {Counter} from "../src/Counter.sol";
import {MockFXRP} from "../src/MockFXRP.sol";
import {MockVault} from "../src/MockVault.sol";
import {InstructionRegistry} from "../src/InstructionRegistry.sol";

/**
 * Deploys the ONESIG demo surface to Coston2 and writes the addresses to
 * deployments/<chainid>.json so the SDK, executor and frontend all read one
 * source of truth instead of hardcoding.
 *
 *   forge script script/Deploy.s.sol --rpc-url $CHAIN_URL --broadcast
 */
contract Deploy is Script {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        vm.startBroadcast(pk);

        Counter counter = new Counter();
        MockFXRP fxrp = new MockFXRP();
        MockVault vault = new MockVault(fxrp);
        InstructionRegistry registry = new InstructionRegistry();

        // Seed the directory so a wallet renders English, not hex, from block one.
        registry.register(
            address(vault),
            MockVault.deposit.selector,
            "MockVault",
            "Deposit {0} mFXRP into MockVault"
        );
        registry.register(
            address(counter),
            Counter.increment.selector,
            "Counter",
            "Increment the Gate 1 counter"
        );

        vm.stopBroadcast();

        console2.log("Counter            ", address(counter));
        console2.log("MockFXRP           ", address(fxrp));
        console2.log("MockVault          ", address(vault));
        console2.log("InstructionRegistry", address(registry));

        string memory json = string.concat(
            '{\n  "chainId": ', vm.toString(block.chainid),
            ',\n  "Counter": "', vm.toString(address(counter)),
            '",\n  "MockFXRP": "', vm.toString(address(fxrp)),
            '",\n  "MockVault": "', vm.toString(address(vault)),
            '",\n  "InstructionRegistry": "', vm.toString(address(registry)),
            '"\n}\n'
        );
        vm.writeFile(string.concat("deployments/", vm.toString(block.chainid), ".json"), json);
    }
}
