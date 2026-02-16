package dag

import (
	"sort"
	"strings"

	"github.com/ankitiscracked/fastest/cli/internal/ui"
)

// SnapshotInfo is the minimal snapshot data needed for graph rendering.
type SnapshotInfo struct {
	ID        string
	ParentIDs []string
	CreatedAt string
}

// GraphRow contains the rendered graph lines for a single snapshot.
type GraphRow struct {
	// PreLines are edge lines rendered before the node (merge-in).
	PreLines []string
	// NodeLine is the line containing the node marker (●/*).
	// Append snapshot info after this prefix.
	NodeLine string
	// PostLines are edge lines rendered after the node (fork-out).
	PostLines []string
}

// GraphRenderer tracks column state and renders graph prefixes row by row.
type GraphRenderer struct {
	columns  []string // each slot tracks the snapshot ID this column descends toward
	g        glyphs
	Colorize bool // when true, apply ANSI colors to graph glyphs
}

// NewGraphRenderer creates a renderer using the active glyph set.
func NewGraphRenderer() *GraphRenderer {
	return &GraphRenderer{g: activeGlyphs()}
}

// NextRow renders the graph prefix for a snapshot. Call in topological order
// (children before parents). Returns the graph lines for this snapshot.
func (r *GraphRenderer) NextRow(id string, parentIDs []string) GraphRow {
	// Find columns currently targeting this snapshot
	targetCols := r.findColumns(id)

	// If no column targets this snapshot, assign a new one
	if len(targetCols) == 0 {
		col := r.freeColumn()
		r.columns[col] = id
		targetCols = []int{col}
	}

	primaryCol := targetCols[0]

	var row GraphRow

	// Pre-lines: merge-in (if multiple columns converge on this snapshot)
	if len(targetCols) > 1 {
		row.PreLines = append(row.PreLines, r.renderMergeIn(primaryCol, targetCols))
		// Free the extra columns
		for _, col := range targetCols[1:] {
			r.columns[col] = ""
		}
		// Compact trailing empty columns
		r.compact()
	}

	// Node line
	row.NodeLine = r.renderNodeLine(primaryCol)

	// Determine new columns for parents
	if len(parentIDs) == 0 {
		// Root snapshot: free the column
		r.columns[primaryCol] = ""
		r.compact()
	} else {
		// First parent continues in the primary column
		r.columns[primaryCol] = parentIDs[0]

		// Additional parents get new columns
		var newCols []int
		for _, pid := range parentIDs[1:] {
			// Check if any existing column already tracks this parent
			existing := r.findColumns(pid)
			if len(existing) > 0 {
				// Already tracked; just need to show the fork line
				newCols = append(newCols, existing[0])
			} else {
				col := r.freeColumn()
				r.columns[col] = pid
				newCols = append(newCols, col)
			}
		}

		// Post-lines: fork-out (if this snapshot has multiple parents)
		if len(newCols) > 0 {
			row.PostLines = append(row.PostLines, r.renderForkOut(primaryCol, newCols))
		}
	}

	return row
}

// findColumns returns indices of columns targeting the given snapshot ID.
func (r *GraphRenderer) findColumns(id string) []int {
	var cols []int
	for i, cid := range r.columns {
		if cid == id {
			cols = append(cols, i)
		}
	}
	return cols
}

// freeColumn returns the index of the first empty column, or appends one.
func (r *GraphRenderer) freeColumn() int {
	for i, cid := range r.columns {
		if cid == "" {
			return i
		}
	}
	r.columns = append(r.columns, "")
	return len(r.columns) - 1
}

// compact removes trailing empty columns.
func (r *GraphRenderer) compact() {
	for len(r.columns) > 0 && r.columns[len(r.columns)-1] == "" {
		r.columns = r.columns[:len(r.columns)-1]
	}
}

// renderNodeLine renders the node marker at primaryCol with pass-through lines elsewhere.
func (r *GraphRenderer) renderNodeLine(primaryCol int) string {
	width := len(r.columns)
	if primaryCol >= width {
		width = primaryCol + 1
	}

	parts := make([]string, width)
	for i := 0; i < width; i++ {
		if i == primaryCol {
			parts[i] = string(r.g.tee) // placeholder, replaced below
		} else if i < len(r.columns) && r.columns[i] != "" {
			parts[i] = r.colorDim(string(r.g.vertical))
		} else {
			parts[i] = " "
		}
	}

	// Replace the node marker with the proper glyph
	if r.g.vertical == '│' {
		parts[primaryCol] = r.colorYellow("●")
	} else {
		parts[primaryCol] = r.colorYellow("*")
	}

	return strings.TrimRight(strings.Join(parts, " "), " ")
}

// renderMergeIn renders lines showing extra columns converging into primaryCol.
// Example (cols 0 and 2 merge, primary=0):  "╰─┤" or "|/"
func (r *GraphRenderer) renderMergeIn(primaryCol int, targetCols []int) string {
	width := len(r.columns)
	for _, c := range targetCols {
		if c >= width {
			width = c + 1
		}
	}

	parts := make([]string, width)
	for i := 0; i < width; i++ {
		if i < len(r.columns) && r.columns[i] != "" {
			parts[i] = r.colorDim(string(r.g.vertical))
		} else {
			parts[i] = " "
		}
	}

	// For each extra column, draw a diagonal line to primary
	// We handle the common case: extra columns are to the right of primary
	for _, col := range targetCols[1:] {
		if col > primaryCol {
			// Draw from col toward primary: replace chars between
			parts[primaryCol] = r.colorDim(string(r.g.vertical))
			for i := primaryCol + 1; i < col; i++ {
				parts[i] = r.colorDim(string(r.g.horizontal))
			}
			if r.g.vertical == '│' {
				parts[col] = r.colorDim("╯")
			} else {
				parts[col] = r.colorDim("/")
			}
		} else if col < primaryCol {
			if r.g.vertical == '│' {
				parts[col] = r.colorDim("╰")
			} else {
				parts[col] = r.colorDim("\\")
			}
			for i := col + 1; i < primaryCol; i++ {
				parts[i] = r.colorDim(string(r.g.horizontal))
			}
			parts[primaryCol] = r.colorDim(string(r.g.vertical))
		}
	}

	return strings.TrimRight(strings.Join(parts, " "), " ")
}

// renderForkOut renders lines showing the primary column forking to new columns.
// Example (primary=0, new col=1): "├─╮" or "|\"
func (r *GraphRenderer) renderForkOut(primaryCol int, newCols []int) string {
	width := len(r.columns)
	for _, c := range newCols {
		if c >= width {
			width = c + 1
		}
	}

	parts := make([]string, width)
	for i := 0; i < width; i++ {
		if i < len(r.columns) && r.columns[i] != "" {
			parts[i] = r.colorDim(string(r.g.vertical))
		} else {
			parts[i] = " "
		}
	}

	// Draw fork lines from primary to each new column
	for _, col := range newCols {
		if col > primaryCol {
			if r.g.vertical == '│' {
				parts[primaryCol] = r.colorDim("├")
			} else {
				parts[primaryCol] = r.colorDim("|")
			}
			for i := primaryCol + 1; i < col; i++ {
				parts[i] = r.colorDim(string(r.g.horizontal))
			}
			if r.g.vertical == '│' {
				parts[col] = r.colorDim("╮")
			} else {
				parts[col] = r.colorDim("\\")
			}
		} else if col < primaryCol {
			if r.g.vertical == '│' {
				parts[col] = r.colorDim("╭")
			} else {
				parts[col] = r.colorDim("/")
			}
			for i := col + 1; i < primaryCol; i++ {
				parts[i] = r.colorDim(string(r.g.horizontal))
			}
			if r.g.vertical == '│' {
				parts[primaryCol] = r.colorDim("┤")
			} else {
				parts[primaryCol] = r.colorDim("|")
			}
		}
	}

	return strings.TrimRight(strings.Join(parts, " "), " ")
}

// colorDim wraps s with dim color when Colorize is enabled.
func (r *GraphRenderer) colorDim(s string) string {
	if r.Colorize {
		return ui.Dim(s)
	}
	return s
}

// colorYellow wraps s with yellow color when Colorize is enabled.
func (r *GraphRenderer) colorYellow(s string) string {
	if r.Colorize {
		return ui.Yellow(s)
	}
	return s
}

// TopoSort performs a topological sort of snapshots (children before parents),
// breaking ties by CreatedAt descending (newest first).
// heads are the starting snapshot IDs. snaps maps ID → SnapshotInfo.
func TopoSort(heads []string, snaps map[string]*SnapshotInfo) []*SnapshotInfo {
	// Build indegree: count of children for each snapshot
	// (a snapshot's indegree = number of other snapshots listing it as a parent)
	indegree := make(map[string]int, len(snaps))
	for id := range snaps {
		indegree[id] = 0
	}
	for _, snap := range snaps {
		for _, pid := range snap.ParentIDs {
			if _, ok := snaps[pid]; ok {
				indegree[pid]++
			}
		}
	}

	// Start with indegree-0 nodes (tips/heads)
	var queue []*SnapshotInfo
	for id, deg := range indegree {
		if deg == 0 {
			queue = append(queue, snaps[id])
		}
	}
	sortByTime(queue)

	var result []*SnapshotInfo
	for len(queue) > 0 {
		current := queue[0]
		queue = queue[1:]
		result = append(result, current)

		for _, pid := range current.ParentIDs {
			if _, ok := snaps[pid]; !ok {
				continue
			}
			indegree[pid]--
			if indegree[pid] == 0 {
				queue = append(queue, snaps[pid])
				sortByTime(queue)
			}
		}
	}

	return result
}

func sortByTime(s []*SnapshotInfo) {
	sort.Slice(s, func(i, j int) bool {
		return s[i].CreatedAt > s[j].CreatedAt
	})
}

// CollectReachable performs BFS from the given heads through all parent links,
// returning all reachable snapshot IDs.
func CollectReachable(heads []string, snaps map[string]*SnapshotInfo) map[string]*SnapshotInfo {
	reachable := make(map[string]*SnapshotInfo)
	queue := make([]string, 0, len(heads))

	for _, h := range heads {
		if _, ok := snaps[h]; ok {
			if _, seen := reachable[h]; !seen {
				reachable[h] = snaps[h]
				queue = append(queue, h)
			}
		}
	}

	for len(queue) > 0 {
		current := queue[0]
		queue = queue[1:]

		snap := snaps[current]
		if snap == nil {
			continue
		}

		for _, pid := range snap.ParentIDs {
			if _, ok := snaps[pid]; !ok {
				continue
			}
			if _, seen := reachable[pid]; !seen {
				reachable[pid] = snaps[pid]
				queue = append(queue, pid)
			}
		}
	}

	return reachable
}
