package main

import (
	"fmt"
	"os"
	"syscall"
)

const (
	collectorBinary = "/otelcol-contrib"
	defaultConfig   = "/etc/otelcol-contrib/config.yaml"
	baseConfig      = "/etc/otelcol-contrib/config.yaml"
)

func collectorArgs(args []string, config string) []string {
	if len(args) > 0 && !isInheritedBaseConfig(args) {
		return args
	}
	if config == "" {
		config = defaultConfig
	}
	return []string{"--config=" + config}
}

func isInheritedBaseConfig(args []string) bool {
	if len(args) == 1 {
		return args[0] == "--config="+baseConfig
	}
	if len(args) == 2 {
		return args[0] == "--config" && args[1] == baseConfig
	}
	return false
}

func main() {
	args := collectorArgs(os.Args[1:], os.Getenv("COLLECTOR_CONFIG"))
	if err := syscall.Exec(collectorBinary, append([]string{collectorBinary}, args...), os.Environ()); err != nil {
		fmt.Fprintf(os.Stderr, "exec %s: %v\n", collectorBinary, err)
		os.Exit(127)
	}
}
