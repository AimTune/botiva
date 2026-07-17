module github.com/aimtune/botiva/runtimes/langchaingo

go 1.22.0

require (
	github.com/aimtune/botiva/core v0.0.0
	github.com/tmc/langchaingo v0.1.13
)

require (
	github.com/dlclark/regexp2 v1.10.0 // indirect
	github.com/google/uuid v1.6.0 // indirect
	github.com/pkoukk/tiktoken-go v0.1.6 // indirect
)

replace github.com/aimtune/botiva/core => ../../core/go
