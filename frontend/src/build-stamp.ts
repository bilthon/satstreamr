export type BuildStamp = {
  version: string;
  commit: string | null;
};

const BUILD_STAMP_TOKEN = '__BUILD_STAMP_LABEL__';

export function normalizeCommit(raw: string | null | undefined): string | null {
  const commit = raw?.trim().toLowerCase();
  return commit && /^[0-9a-f]{6,40}$/.test(commit) ? commit : null;
}

export function resolveBuildStamp(input: {
  version: string;
  envCommit: string | undefined;
  githubSha: string | undefined;
  gitHead: string | undefined;
}): BuildStamp {
  const commit = [input.envCommit, input.githubSha, input.gitHead]
    .map(normalizeCommit)
    .find(candidate => candidate !== null) ?? null;
  return { version: input.version, commit };
}

export function buildStampLabel(stamp: BuildStamp): string {
  return stamp.commit === null ? `v${stamp.version}` : `v${stamp.version} · ${stamp.commit.slice(0, 6)}`;
}

export function injectBuildStamp(html: string, label: string): string {
  const escaped = label.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return html.replaceAll(BUILD_STAMP_TOKEN, () => escaped);
}
