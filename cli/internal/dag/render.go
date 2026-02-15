package dag

import (
	"fmt"
	"os"
	"strings"

	"github.com/anthropics/fastest/cli/internal/ui"
)

// MergeDiagramOpts configures the mini-diagram rendered after merge operations.
type MergeDiagramOpts struct {
	CurrentID     string // left head snapshot ID (will be truncated to 8 chars)
	SourceID      string // right head snapshot ID (will be truncated to 8 chars)
	MergeBaseID   string // common ancestor snapshot ID (may be empty)
	MergedID      string // result snapshot ID (empty for dry-run or pending)
	CurrentLabel  string // left column label (e.g. workspace name)
	SourceLabel   string // right column label (e.g. source workspace or "remote")
	Message       string // merge message (e.g. "Merged feature")
	Pending       bool   // true when merge is incomplete (conflicts need resolution)
	ConflictCount int    // number of conflicting files (shown when Pending is true)
	Colorize      bool   // true to apply ANSI colors to diagram elements
}

type glyphs struct {
	vertical   rune
	connLeft   rune
	connRight  rune
	horizontal rune
	tee        rune
}

var (
	unicodeGlyphs = glyphs{
		vertical:   '│',
		connLeft:   '╰',
		connRight:  '╯',
		horizontal: '─',
		tee:        '┬',
	}
	asciiGlyphs = glyphs{
		vertical:   '|',
		connLeft:   '\\',
		connRight:  '/',
		horizontal: '-',
		tee:        '+',
	}
)

var unicodeOverride *bool

// SetUnicode forces Unicode or ASCII mode. Pass true for Unicode, false for ASCII.
func SetUnicode(v bool) { unicodeOverride = &v }

// ResetUnicode clears the override and reverts to auto-detection.
func ResetUnicode() { unicodeOverride = nil }

func activeGlyphs() glyphs {
	if unicodeOverride != nil {
		if *unicodeOverride {
			return unicodeGlyphs
		}
		return asciiGlyphs
	}
	if supportsUnicode() {
		return unicodeGlyphs
	}
	return asciiGlyphs
}

func supportsUnicode() bool {
	for _, env := range []string{"LC_ALL", "LC_CTYPE", "LANG"} {
		val := strings.ToUpper(os.Getenv(env))
		if val != "" {
			return strings.Contains(val, "UTF-8") || strings.Contains(val, "UTF8")
		}
	}
	// Windows Terminal supports Unicode
	if os.Getenv("WT_SESSION") != "" {
		return true
	}
	return false
}

func shortID(id string) string {
	if len(id) > 8 {
		return id[:8]
	}
	return id
}

// RenderMergeDiagram returns a multi-line ASCII or Unicode diagram showing
// a merge operation: two parent heads converging into a merged snapshot.
func RenderMergeDiagram(opts MergeDiagramOpts) string {
	g := activeGlyphs()

	leftLabel := opts.CurrentLabel
	rightLabel := opts.SourceLabel
	leftID := shortID(opts.CurrentID)
	rightID := shortID(opts.SourceID)

	var mergedID string
	if opts.Pending {
		mergedID = "(pending)"
	} else if opts.MergedID != "" {
		mergedID = shortID(opts.MergedID)
	} else {
		mergedID = "merge?"
	}

	const shortLen = 8
	leftColW := max(len(leftLabel), shortLen)
	rightColW := max(len(rightLabel), shortLen)

	const pad = 4
	const minGap = 8

	leftCenter := pad + leftColW/2
	rightCenter := leftCenter + leftColW/2 + minGap + rightColW/2
	mergeCenter := (leftCenter + rightCenter) / 2
	totalWidth := rightCenter + rightColW/2 + pad

	if !opts.Colorize {
		return renderMergePlain(opts, g, leftLabel, rightLabel, leftID, rightID, mergedID,
			leftCenter, rightCenter, mergeCenter, totalWidth)
	}
	return renderMergeColored(opts, g, leftLabel, rightLabel, leftID, rightID, mergedID,
		leftCenter, rightCenter, mergeCenter, totalWidth)
}

func renderMergePlain(opts MergeDiagramOpts, g glyphs,
	leftLabel, rightLabel, leftID, rightID, mergedID string,
	leftCenter, rightCenter, mergeCenter, totalWidth int) string {

	var lines []string

	// Labels
	lines = append(lines, placeLine(totalWidth,
		placement{leftLabel, leftCenter},
		placement{rightLabel, rightCenter},
	))

	// Vertical connectors
	lines = append(lines, placeGlyphs(totalWidth, g.vertical, leftCenter, rightCenter))

	// Short IDs
	lines = append(lines, placeLine(totalWidth,
		placement{leftID, leftCenter},
		placement{rightID, rightCenter},
	))

	// Merge connector: ╰────┬────╯
	lines = append(lines, buildConnector(totalWidth, leftCenter, rightCenter, mergeCenter, g))

	// Merged snapshot ID
	lines = append(lines, placeLine(totalWidth, placement{mergedID, mergeCenter}))

	// Message
	if opts.Message != "" {
		lines = append(lines, placeLine(totalWidth, placement{opts.Message, mergeCenter}))
	}

	// Conflict info for pending merges
	if opts.Pending && opts.ConflictCount > 0 {
		conflictText := fmt.Sprintf("(%d conflicts to resolve)", opts.ConflictCount)
		lines = append(lines, placeLine(totalWidth, placement{conflictText, mergeCenter}))
	}

	// Base
	if opts.MergeBaseID != "" {
		baseText := "(base: " + shortID(opts.MergeBaseID) + ")"
		lines = append(lines, placeLine(totalWidth, placement{baseText, mergeCenter}))
	}

	return strings.Join(lines, "\n")
}

func renderMergeColored(opts MergeDiagramOpts, g glyphs,
	leftLabel, rightLabel, leftID, rightID, mergedID string,
	leftCenter, rightCenter, mergeCenter, totalWidth int) string {

	var lines []string

	// Labels (green)
	lines = append(lines, placeColoredLine(totalWidth,
		coloredPlacement{ui.Green(leftLabel), len(leftLabel), leftCenter},
		coloredPlacement{ui.Green(rightLabel), len(rightLabel), rightCenter},
	))

	// Vertical connectors (dim)
	vertStr := string(g.vertical)
	lines = append(lines, placeColoredLine(totalWidth,
		coloredPlacement{ui.Dim(vertStr), 1, leftCenter},
		coloredPlacement{ui.Dim(vertStr), 1, rightCenter},
	))

	// Short IDs (yellow)
	lines = append(lines, placeColoredLine(totalWidth,
		coloredPlacement{ui.Yellow(leftID), len(leftID), leftCenter},
		coloredPlacement{ui.Yellow(rightID), len(rightID), rightCenter},
	))

	// Merge connector (dim)
	connPlain := buildConnector(totalWidth, leftCenter, rightCenter, mergeCenter, g)
	lines = append(lines, ui.Dim(connPlain))

	// Merged snapshot ID
	mergedDisplay := len(mergedID)
	if opts.Pending {
		mergedID = ui.Red(mergedID)
	} else {
		mergedID = ui.Yellow(mergedID)
	}
	lines = append(lines, placeColoredLine(totalWidth,
		coloredPlacement{mergedID, mergedDisplay, mergeCenter},
	))

	// Message (bold)
	if opts.Message != "" {
		lines = append(lines, placeColoredLine(totalWidth,
			coloredPlacement{ui.Bold(opts.Message), len(opts.Message), mergeCenter},
		))
	}

	// Conflict info (red)
	if opts.Pending && opts.ConflictCount > 0 {
		conflictText := fmt.Sprintf("(%d conflicts to resolve)", opts.ConflictCount)
		lines = append(lines, placeColoredLine(totalWidth,
			coloredPlacement{ui.Red(conflictText), len(conflictText), mergeCenter},
		))
	}

	// Base (dim)
	if opts.MergeBaseID != "" {
		baseText := "(base: " + shortID(opts.MergeBaseID) + ")"
		lines = append(lines, placeColoredLine(totalWidth,
			coloredPlacement{ui.Dim(baseText), len(baseText), mergeCenter},
		))
	}

	return strings.Join(lines, "\n")
}

type placement struct {
	text   string
	center int
}

// coloredPlacement positions a possibly ANSI-colored string by its display width.
type coloredPlacement struct {
	text       string // may contain ANSI escape codes
	displayLen int    // visible character count (without ANSI codes)
	center     int    // target center column
}

// placeColoredLine builds a line by positioning colored text segments using
// padding. Unlike placeLine, this handles ANSI escape codes correctly by
// tracking display width separately from string length.
func placeColoredLine(totalWidth int, items ...coloredPlacement) string {
	// Sort items left to right by start position
	type positioned struct {
		text  string
		start int
		dispW int
	}
	parts := make([]positioned, len(items))
	for i, item := range items {
		parts[i] = positioned{
			text:  item.text,
			start: item.center - item.displayLen/2,
			dispW: item.displayLen,
		}
	}

	var sb strings.Builder
	col := 0
	for _, p := range parts {
		if p.start > col {
			sb.WriteString(strings.Repeat(" ", p.start-col))
			col = p.start
		}
		sb.WriteString(p.text)
		col += p.dispW
	}
	return sb.String()
}

// placeLine builds a line with one or more text strings centered at given positions.
func placeLine(width int, items ...placement) string {
	canvas := makeCanvas(width)
	for _, item := range items {
		placeText(canvas, item.text, item.center)
	}
	return strings.TrimRight(string(canvas), " ")
}

// placeGlyphs puts a single glyph at each position.
func placeGlyphs(width int, g rune, positions ...int) string {
	canvas := makeCanvas(width)
	for _, pos := range positions {
		if pos >= 0 && pos < len(canvas) {
			canvas[pos] = g
		}
	}
	return strings.TrimRight(string(canvas), " ")
}

// buildConnector renders the merge connector line: ╰────┬────╯
func buildConnector(width, left, right, mid int, g glyphs) string {
	canvas := makeCanvas(width)
	canvas[left] = g.connLeft
	canvas[right] = g.connRight
	canvas[mid] = g.tee
	for i := left + 1; i < mid; i++ {
		canvas[i] = g.horizontal
	}
	for i := mid + 1; i < right; i++ {
		canvas[i] = g.horizontal
	}
	return strings.TrimRight(string(canvas), " ")
}

func makeCanvas(width int) []rune {
	canvas := make([]rune, width)
	for i := range canvas {
		canvas[i] = ' '
	}
	return canvas
}

func placeText(canvas []rune, text string, center int) {
	runes := []rune(text)
	start := center - len(runes)/2
	for i, r := range runes {
		pos := start + i
		if pos >= 0 && pos < len(canvas) {
			canvas[pos] = r
		}
	}
}
