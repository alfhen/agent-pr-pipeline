# Input: the issue's comments as one array.
# Args: $prefix (the marker prefix, for example "<!-- pipeline:quick-brief") and $user (the login from GET /user).
# Optional named arg: all, set to "1" to get the list form.
# Output: the full body of the one comment that starts with $prefix and was written by $user, or null when there is none.
# With all=1: the list of every such body, and two matches are not an error.
# Two such comments are the only error: a malformed element is skipped, so callers can read a failure as "two".
# Comments by any other account are ignored, so a forged marker does nothing.
[.[] | objects | select((.user | objects | .login) == $user and ((.body | strings) // "" | startswith($prefix))) | .body]
| if $ARGS.named.all == "1" then .
  elif length > 1 then error("more than one trusted comment starts with " + $prefix)
  else (.[0] // null) end
