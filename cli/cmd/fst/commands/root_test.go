package commands

import (
	"reflect"
	"testing"
)

func TestVersionCommandRuns(t *testing.T) {
	cmd := NewRootCmd()
	cmd.SetArgs([]string{"version"})
	if err := cmd.Execute(); err != nil {
		t.Fatalf("version command failed: %v", err)
	}
}

func TestCloneRequiresArg(t *testing.T) {
	cmd := NewRootCmd()
	cmd.SetArgs([]string{"workspace", "clone"})
	if err := cmd.Execute(); err == nil {
		t.Fatalf("expected clone without args to fail")
	}
}

func TestRewriteArgsAgentMessageAlias(t *testing.T) {
	cases := []struct {
		name string
		in   []string
		out  []string
	}{
		{
			name: "short flag",
			in:   []string{"snapshot", "-am"},
			out:  []string{"snapshot", "--agent-message"},
		},
		{
			name: "short flag with equals",
			in:   []string{"snapshot", "-am=1"},
			out:  []string{"snapshot", "--agent-message=1"},
		},
		{
			name: "unrelated args unchanged",
			in:   []string{"snapshot", "-m", "hi"},
			out:  []string{"snapshot", "-m", "hi"},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := rewriteArgs(tc.in)
			if !reflect.DeepEqual(got, tc.out) {
				t.Fatalf("rewriteArgs(%v)=%v, want %v", tc.in, got, tc.out)
			}
		})
	}
}
