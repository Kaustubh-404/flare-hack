// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

import {Test} from "forge-std/Test.sol";
import {Counter} from "../src/Counter.sol";
import {MockFXRP} from "../src/MockFXRP.sol";
import {MockVault} from "../src/MockVault.sol";
import {InstructionRegistry} from "../src/InstructionRegistry.sol";

contract CounterTest is Test {
    Counter counter;

    function setUp() public {
        counter = new Counter();
    }

    function test_incrementRecordsCaller() public {
        address pa = makeAddr("personalAccount");
        vm.prank(pa);
        counter.increment();
        assertEq(counter.count(), 1);
        // The Gate 1 assertion: the call arrived from the personal account,
        // not from an EOA poking the contract directly.
        assertEq(counter.lastCaller(), pa);
    }

    function test_batchAppliesInOrder() public {
        counter.increment();
        counter.incrementBy(41);
        assertEq(counter.count(), 42);
    }
}

contract MockVaultTest is Test {
    MockFXRP token;
    MockVault vault;
    address user = makeAddr("user");

    function setUp() public {
        token = new MockFXRP();
        vault = new MockVault(token);
        token.mint(user, 1_000e6);
    }

    function test_depositAndWithdraw() public {
        vm.startPrank(user);
        token.approve(address(vault), 100e6);
        vault.deposit(100e6);
        assertEq(vault.balanceOf(user), 100e6);
        assertEq(vault.totalDeposits(), 100e6);

        vault.withdraw(40e6);
        assertEq(vault.balanceOf(user), 60e6);
        assertEq(token.balanceOf(user), 940e6);
        vm.stopPrank();
    }

    function test_revertsOnZero() public {
        vm.prank(user);
        vm.expectRevert(MockVault.ZeroAmount.selector);
        vault.deposit(0);
    }

    function test_revertsOnOverdraw() public {
        vm.startPrank(user);
        token.approve(address(vault), 10e6);
        vault.deposit(10e6);
        vm.expectRevert(abi.encodeWithSelector(MockVault.InsufficientBalance.selector, 10e6, 11e6));
        vault.withdraw(11e6);
        vm.stopPrank();
    }
}

contract InstructionRegistryTest is Test {
    InstructionRegistry registry;
    address target = makeAddr("vault");
    bytes4 selector = bytes4(keccak256("deposit(uint256)"));
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    function setUp() public {
        registry = new InstructionRegistry();
    }

    function test_registerAndDescribe() public {
        vm.prank(alice);
        registry.register(target, selector, "MockVault", "Deposit {0} XRP into MockVault");

        (string memory appName, string memory template, address registrant) = registry.describe(target, selector);
        assertEq(appName, "MockVault");
        assertEq(template, "Deposit {0} XRP into MockVault");
        assertEq(registrant, alice);
        assertTrue(registry.isRegistered(target, selector));
    }

    function test_onlyRegistrantMayEdit() public {
        vm.prank(alice);
        registry.register(target, selector, "MockVault", "Deposit {0}");

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(InstructionRegistry.NotRegistrant.selector, alice, bob));
        registry.register(target, selector, "Evil", "Claim free XRP");
    }

    function test_registrantMayUpdateOwnEntry() public {
        vm.startPrank(alice);
        registry.register(target, selector, "MockVault", "Deposit {0}");
        registry.register(target, selector, "MockVault v2", "Deposit {0} XRP");
        vm.stopPrank();

        (, string memory template,) = registry.describe(target, selector);
        assertEq(template, "Deposit {0} XRP");
    }

    function test_unknownInstructionReverts() public {
        vm.expectRevert(abi.encodeWithSelector(InstructionRegistry.UnknownInstruction.selector, target, selector));
        registry.describe(target, selector);
    }

    function test_emptyTemplateRejected() public {
        vm.expectRevert(InstructionRegistry.EmptyTemplate.selector);
        registry.register(target, selector, "X", "");
    }
}
