#!/bin/bash
# usage: plugin-repo.sh
# Prints the plugin's own repo as a lowercase owner/name, from the repository in the .claude-plugin/plugin.json
# next to this script. Exit 1 when there is no usable repository. Nothing else parses that field.
here=$(cd "$(dirname "$0")" && pwd)
repo=$(jq -r '.repository // ""' "$here/../.claude-plugin/plugin.json" 2>/dev/null | sed -E 's#^(https?://github\.com/|git@github\.com:)##; s#(\.git)?/?$##' | tr '[:upper:]' '[:lower:]')
[[ "$repo" =~ ^[^/]+/[^/]+$ ]] || { echo "plugin-repo.sh: no usable repository in the plugin manifest" >&2; exit 1; }
echo "$repo"
