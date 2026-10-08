## Pre-Rebase commit

0000000000000000000000000000000000000000

## Review results

Good findings. Please fix them all, considering these comments:
...
Do it on this branch (it contains all the changes from the reviewed branch). I.e., do not check out the reviewed branch.

## Useful commands

```shell
git log --oneline --decorate --simplify-by-decoration main..HEAD
git for-each-ref --merged HEAD --no-merged main --format='%(refname:short)' refs/heads/ --sort=-committerdate
```

## Find branch for a commit

```shell
sha=$(git log --format=%H --fixed-strings --grep='your subject here' main..HEAD)
git name-rev --name-only --refs='refs/heads/*' "$sha"
```

## Full rebase recover

```shell
for b in $(git for-each-ref --format='%(refname:short)' refs/heads); do
  n=$(git reflog show "$b" --format='%gs' \
      | grep -n -m1 -E 'rewritten during rebase|^rebase \(finish\)' \
      | cut -d: -f1)
  [ -n "$n" ] || continue
  #echo "$b: $(git rev-parse --short "$b") -> $(git rev-parse --short "$b@{$n}")"
  echo git update-ref "refs/heads/$b" "$b@{$n}"     # drop the echo to apply
done
```

## Get write repos

gh repo list helse-sorost --json name,viewerPermission -L 1000 --jq '.[] | select(.viewerPermission == "WRITE" or .viewerPermission == "MAINTAIN" or .viewerPermission == "ADMIN") | .name'
