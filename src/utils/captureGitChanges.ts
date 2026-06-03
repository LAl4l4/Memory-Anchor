import { execSync } from 'child_process';

interface GitChange {
    status: 'M' | 'A' | '??' | string;
    file: string;
}

function captureGitChanges(): GitChange[] | null {
    try {
        const gitStatus = execSync('git status --porcelain', { encoding: 'utf-8' }).trim();
        if (!gitStatus) return null;

        return gitStatus.split('\n').map((line): GitChange => {
            const trimmed = line.trim();
            const parts = trimmed.split(/\s+/);
            return {
                status: parts[0],
                file: parts[1]
            };
        });
    } catch (e) {
        return null;
    }
}

export { captureGitChanges, GitChange };