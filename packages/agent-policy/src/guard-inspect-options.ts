/** Positive option grammar: unknown flags fall through to the existing allowlist. */
export function readOperands(args: string[], flags: string, values = ""): string[] | null {
  const plain = new Set(flags.split(" "));
  const valued = new Set(values.split(" "));
  const operands: string[] = [];
  let options = true;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (options && arg === "--") options = false;
    else if (!options || !arg.startsWith("-") || arg === "-") operands.push(arg);
    else if (plain.has(arg)) continue;
    else if (valued.has(arg)) {
      if (args[++i] === undefined) return null;
    } else if (arg.startsWith("--")) {
      if (!arg.includes("=") || !valued.has(arg.split("=")[0]!)) return null;
    } else {
      const consumed = shortOptions(arg.slice(1), plain, valued);
      if (consumed === null || (consumed === 1 && args[++i] === undefined)) return null;
    }
  }
  return operands;
}

function shortOptions(cluster: string, flags: Set<string>, values: Set<string>): 0 | 1 | null {
  for (let i = 0; i < cluster.length; i++) {
    const option = "-" + cluster[i];
    if (values.has(option)) return i === cluster.length - 1 ? 1 : 0;
    if (!flags.has(option)) return null;
  }
  return cluster.length > 0 ? 0 : null;
}

// Only read-only flags belong here. In particular: no tree -o, file -C,
// diff --output, rg --pre, sort --compress-program or xxd -r.
export const READ_OPTIONS: Record<string, [string, string?]> = {
  jq: ["-r -R -s -c -n -e -S -M -C -j -a --raw-output --raw-input --slurp --compact-output --null-input --exit-status --sort-keys --monochrome-output --join-output --ascii-output"],
  sort: ["-b -d -f -g -h -i -M -n -r -R -s -u -V -z -c -C --reverse --unique --stable --numeric-sort --human-numeric-sort --version-sort --zero-terminated --check", "-k -t -S --key --field-separator --buffer-size --parallel"],
  uniq: ["-c -d -D -i -u -z --count --repeated --ignore-case --unique --zero-terminated", "-f -s -w --skip-fields --skip-chars --check-chars"],
  cut: ["-s -z --complement --only-delimited --zero-terminated", "-b -c -f -d --bytes --characters --fields --delimiter --output-delimiter"],
  tr: ["-c -C -d -s -t --complement --delete --squeeze-repeats --truncate-set1"],
  wc: ["-c -m -l -L -w --bytes --chars --lines --max-line-length --words"],
  diff: ["-a -b -B -i -q -r -s -u -w -y -N --text --brief --recursive --unified --ignore-all-space --ignore-space-change --strip-trailing-cr", "-U -C -I -x -X --exclude --exclude-from --label"],
  cmp: ["-b -l -s --print-bytes --verbose --silent --quiet", "-i -n --ignore-initial --bytes"],
  file: ["-b -h -i -k -L -N -p -r -s -z -0 --brief --mime --mime-type --mime-encoding --keep-going --dereference --no-dereference --preserve-date --raw --uncompress"],
  stat: ["-L -f -t --dereference --file-system --terse", "-c --format --printf"],
  du: ["-a -b -c -h -H -k -L -l -m -P -s -S -x -0 --all --apparent-size --total --human-readable --summarize --one-file-system --null", "-d -B --max-depth --block-size --exclude --exclude-from"],
  df: ["-a -h -H -i -k -l -P -T --all --human-readable --inodes --local --portability --print-type", "-B -t -x --block-size --type --exclude-type"],
  tree: ["-a -d -f -i -l -p -s -h -D -F -Q -N -r -t -u -g -n -C -x --noreport --dirsfirst --du --prune --gitignore", "-L -P -I --filelimit --sort"],
  which: ["-a -s --all"], type: ["-a -f -p -P -t"],
  basename: ["-a -z --multiple --zero", "-s --suffix"], dirname: ["-z --zero"],
  realpath: ["-e -m -L -P -q -s -z --canonicalize-existing --canonicalize-missing --logical --physical --quiet --strip --zero", "--relative-to --relative-base"],
  readlink: ["-e -f -m -n -q -s -v -z --canonicalize --canonicalize-existing --canonicalize-missing --no-newline --quiet --silent --verbose --zero"],
  nl: ["-p --no-renumber", "-b -d -f -h -i -l -n -s -v -w --body-numbering --footer-numbering --header-numbering --number-format --number-separator --number-width"],
  column: ["-t -x -J --table --json", "-c -s -o -N --output-width --separator --output-separator --table-columns"],
  comm: ["-1 -2 -3 -z --check-order --nocheck-order --total --zero-terminated", "--output-delimiter"],
  xxd: ["-a -b -E -e -i -p -ps -u", "-c -g -l -s"],
  od: ["-a -b -c -d -f -i -l -o -s -x -v --output-duplicates", "-A -j -N -t -w --address-radix --skip-bytes --read-bytes --format --width"],
  head: ["-q -v -z --quiet --silent --verbose --zero-terminated", "-c -n --bytes --lines"],
  tail: ["-q -v -z --quiet --silent --verbose --zero-terminated", "-c -n --bytes --lines"],
  cat: ["-A -b -e -E -n -s -t -T -u -v --show-all --number-nonblank --show-ends --number --squeeze-blank --show-tabs --show-nonprinting"],
  grep: ["-a -b -c -E -F -G -h -H -i -I -l -L -n -o -P -q -r -R -s -v -w -x -z --color --line-number --ignore-case --invert-match --files-with-matches --count", "-e -f -m -A -B -C --regexp --file --max-count --after-context --before-context --context --include --exclude --exclude-dir"],
  rg: ["-a -c -F -i -l -L -n -N -o -q -s -S -u -U -v -w -x -z --files --hidden --no-ignore --line-number --count --files-with-matches --ignore-case --fixed-strings --multiline --pcre2", "-e -f -g -t -m -A -B -C --regexp --file --glob --iglob --type --type-not --max-count --after-context --before-context --context --color"],
  ls: ["-a -A -b -c -C -d -f -F -g -G -h -H -i -k -l -L -m -n -p -q -r -R -s -S -t -u -U -v -x -1 --all --almost-all --directory --human-readable --recursive --color", "-w --sort --time --format --block-size --quoting-style"],
  pwd: ["-L -P --logical --physical"],
};
