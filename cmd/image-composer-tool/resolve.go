package main

import (
	"fmt"
	"path/filepath"
	"strings"

	"github.com/open-edge-platform/image-composer-tool/internal/config"
	"github.com/open-edge-platform/image-composer-tool/internal/utils/logger"
	"github.com/spf13/cobra"
)

// Resolve command flags
var (
	resolveTemplateFile string // Path to the template to resolve
	resolveFull         bool   // Include OS defaults in the merged output
)

// createResolveCommand creates the resolve subcommand
func createResolveCommand() *cobra.Command {
	resolveCmd := &cobra.Command{
		Use:   "resolve [flags]",
		Short: "Resolve a template and print the merged YAML",
		Long: `Resolve a template and print the merged YAML to stdout for debugging and traceability.

By default, resolve walks the template's extends chain and prints the chain-merged
result WITHOUT OS defaults. If the template does not use extends, resolve prints
a short message and exits.

Use --full to additionally merge OS defaults, producing the exact template that
would be used at build time.

Sensitive fields (user passwords, hash algorithms, and secure boot key/certificate
paths) are always redacted in the output. The merged output is always computed
on-demand and is never cached.`,
		Args:              cobra.NoArgs,
		RunE:              executeResolve,
		ValidArgsFunction: templateFileCompletion,
	}

	resolveCmd.Flags().StringVarP(&resolveTemplateFile, "template", "t", "",
		"Path to the image template YAML file (required)")
	resolveCmd.Flags().BoolVar(&resolveFull, "full", false,
		"Include OS defaults in the merged output, showing exactly what will be built")
	if err := resolveCmd.MarkFlagRequired("template"); err != nil {
		panic(fmt.Sprintf("failed to mark --template as required: %v", err))
	}

	return resolveCmd
}

// executeResolve handles the resolve command execution logic
func executeResolve(cmd *cobra.Command, _ []string) error {
	log := logger.Logger()
	templateFile := resolveTemplateFile

	leaf, err := config.LoadTemplate(templateFile, false)
	if err != nil {
		return fmt.Errorf("resolving template: %w", err)
	}

	hasExtends := strings.TrimSpace(leaf.Extends) != ""

	if !hasExtends && !resolveFull {
		_, _ = fmt.Fprintln(cmd.OutOrStdout(), "No extends used in template, nothing to resolve")
		return nil
	}

	var merged *config.ImageTemplate
	if resolveFull {
		log.Infof("Resolving template with OS defaults: %s", templateFile)
		merged, err = config.LoadAndMergeTemplate(templateFile)
		if err != nil {
			return fmt.Errorf("resolving template: %w", err)
		}
	} else {
		log.Infof("Resolving extends chain for template: %s", templateFile)
		mergedChain, chainPaths, chainErr := config.ResolveAndMergeExtendsChain(templateFile, leaf)
		if chainErr != nil {
			return fmt.Errorf("resolving template: %w", chainErr)
		}
		names := make([]string, len(chainPaths))
		for i, p := range chainPaths {
			names[i] = filepath.Base(p)
		}
		log.Infof("Resolved extends chain: %s", strings.Join(names, " -> "))
		merged = mergedChain
	}

	redacted := config.RedactSensitiveData(merged)

	data, err := config.MarshalTemplateYAML(redacted)
	if err != nil {
		return fmt.Errorf("resolving template: %w", err)
	}

	_, _ = fmt.Fprint(cmd.OutOrStdout(), string(data))
	return nil
}
