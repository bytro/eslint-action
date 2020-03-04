const eslint = require('eslint');
const Git = require('nodegit');
const process = require('process');

const DEFAULT_TARGET_BRANCH = 'origin/develop';
const DEFAULT_REPOSITORY_PATH = '.';
const DEFAULT_FILE_FILTER_REGEX = /\.(?:js|ts)$/;
const DEFAULT_FILE_ENCODING = 'utf8';

async function treeEntryByPath(tree, path) {
    try {
        const treeEntry = await tree.entryByPath(path);
        treeEntry.parent = tree; // BUG: Tree.entryByPath does not set parent
        return treeEntry;
    } catch (e) {
        return undefined;
    }
}

// async function getBlobContent(tree, path, encoding) {
//     const treeEntry = await treeEntryByPath(path, encoding);
//     const blob = await treeEntry.getBlob().then(blob => blob.content().toString(encoding));
//     return blob.content().toString(encoding);
// }

function intersects(lines, from, to) {
    for (const [otherFrom, otherTo] of lines) {
        if (from <= otherTo && otherFrom <= to) {
            return true;
        }
    }
    return false;
}

async function lintFeatureBranch(options) {
    const { sourceBranch, targetBranch, repoPath } = {
        sourceBranch: undefined,
        targetBranch: DEFAULT_TARGET_BRANCH,
        repoPath: DEFAULT_REPOSITORY_PATH,
        fileFilterRegex: DEFAULT_FILE_FILTER_REGEX,
        fileEncoding: DEFAULT_FILE_ENCODING,
        ...options,
    };

    const repo = await Git.Repository.open(repoPath);
    const head = await repo.head();
    if (head.shorthand() !== sourceBranch) {
        // We only require this so ESLint CLIEngine#executeOnFiles() will recursively apply configs
        // in subdirectories.
        // TODO: Check if index and workdir are clean.
        throw new Error('Source branch needs to be checked out.');
    }
    // const status = await repo.getStatus({ show: Git.Status.SHOW.INDEX_AND_WORKDIR });
    const [sourceCommit, targetCommit] = await Promise.all([
        repo.getBranchCommit(sourceBranch),
        repo.getBranchCommit(targetBranch),
    ]);
    const base = await Git.Merge.base(repo, sourceCommit, targetCommit);
    const baseCommit = await Git.Commit.lookup(repo, base);
    const [sourceTree, baseTree] = await Promise.all([
        sourceCommit.getTree(),
        baseCommit.getTree(),
    ]);

    const cli = new eslint.CLIEngine();

    const diff = await Git.Diff.treeToTree(repo, baseTree, sourceTree, {
        contextLines: 0,
        flags: Git.Diff.OPTION.MINIMAL,
    });
    const patches = await diff.patches();
    const results = await Promise.all(
        patches.map(async patch => {
            const path = patch.newFile().path();
            if (!path.match(/\.(?:js|ts)$/) || cli.isPathIgnored(path)) {
                return null;
            }

            // get file content as string
            const treeEntry = await treeEntryByPath(sourceTree, path);
            if (treeEntry === undefined) {
                return null; // file not in tree
            }
            // const content = await treeEntry
            //     .getBlob()
            //     .then(blob => blob.content().toString(fileEncoding));

            const result = {
                filePath: path,
                messages: [],
                errorCount: 0,
                warningCount: 0,
            };

            // generate ESLint report
            // const report = cli.executeOnText(content);
            const report = cli.executeOnFiles([path]);
            const { messages } = report.results[0];
            if (messages.length === 0) {
                return null;
            }

            const hunks = await patch.hunks();
            const changedLines = await hunks.reduce(async (list, hunk) => {
                list = await list;
                const lines = await hunk.lines();
                for (const l of lines) {
                    if (l.origin() === Git.Diff.LINE.ADDITION) {
                        // console.log(`origin=${l.origin()} numlines=${l.numLines()} old=${l.oldLineno()} new=${l.newLineno()} <${l.content()}>`);
                        list.push([l.newLineno(), l.newLineno() + l.numLines() - 1]);
                    }
                }
                return Promise.resolve(list);
            }, Promise.resolve([]));

            for (const message of messages) {
                if (intersects(changedLines, message.line, message.endLine)) {
                    result.messages.push(message);
                    result.errorCount = message.severity === 2;
                    result.warningCount = message.severity === 1;
                }
            }

            return result.messages.length > 0 ? result : null;
        })
    ).then(r => r.filter(Boolean));

    return results;
}

const [sourceBranch, targetBranch] = process.argv.splice(2);

lintFeatureBranch({ sourceBranch, targetBranch })
    .then(results => {
        if (results.length > 0) {
            process.stdout.write(
                JSON.stringify({
                    sourceBranch,
                    targetBranch,
                    results,
                })
            );
        }
        const [errorCount, warningCount] = results.reduce(
            ([errorCount, warningCount], result) => {
                errorCount += result.errorCount;
                warningCount += result.warningCount;
                return [errorCount, warningCount];
            },
            [0, 0]
        );
        let exitCode;
        if (errorCount > 0) {
            exitCode = 2;
        } else if (warningCount > 0) {
            exitCode = 1;
        } else {
            exitCode = 0;
        }

        process.exit(exitCode);
    })
    .catch(e => {
        process.stderr.write(`Runtime error: ${e.message}`);
        process.exit(666);
    });
