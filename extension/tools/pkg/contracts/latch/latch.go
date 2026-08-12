//go:generate go run github.com/ethereum/go-ethereum/cmd/abigen --abi=LatchInstructionSender.abi --bin=LatchInstructionSender.bin --pkg=latch --type=LatchInstructionSender --out=autogen.go

package latch
