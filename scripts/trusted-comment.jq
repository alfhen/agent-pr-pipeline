# Input: the issue's comments as one array.
# Args: $prefix (the marker prefix, for example "<!-- pipeline:quick-brief") and $user (the login from GET /user).
# Output: the full body of the one comment that starts with $prefix and was written by $user, or null when there is none.
# Two such comments are the only error: a malformed element is skipped, so callers can read a failure as "two".
# Comments by any other account are ignored, so a forged marker does nothing.
[.[] | objects | select((.user | objects | .login) == $user and ((.body | strings) // "" | startswith($prefix))) | .body]
| if length > 1 then error("more than one trusted comment starts with " + $prefix) else (.[0] // null) end
