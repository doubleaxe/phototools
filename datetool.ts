import fs from 'node:fs';
import path from 'node:path';

import { ExifDateTime, exiftool } from 'exiftool-vendored';
import { DateTime, Settings } from 'luxon';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

// ts-node datetools.ts --dryrun -- 20120804
// node --loader ts-node/esm --inspect-brk datetools.ts --dryrun -- 20120804
const args = yargs(hideBin(process.argv))
    .option('source', {
        array: true,
        string: true,
        requiresArg: true,
        default: ['exif', 'path', 'mtime'],
    })
    .option('target', {
        array: true,
        string: true,
        requiresArg: true,
        default: ['mtime'],
    })
    .option('sourcepath', {
        string: true,
        requiresArg: true,
        default: 'yyyyMMdd/[.*]',
    })
    .option('targetpath', {
        string: true,
        requiresArg: true,
        default: 'yyyy/yyyyMMdd/[$1]',
    })
    .option('ext', {
        array: true,
        string: true,
        requiresArg: true,
        default: ['.jpg', '.mts', '.avi', '.mp4'],
    })
    .option('out', {
        string: true,
        requiresArg: true,
        default: 'out',
    })
    .option('dryrun', {
        boolean: true,
    })
    .parseSync();

(async () => {
    const processor = useProcessor(args);
    try {
        const files = args._;
        for (const file of files) {
            await processFile(path.resolve(String(file)), processor);
        }
    } finally {
        await exiftool.end();
    }
})().catch((err) => {
    console.error(err);
    process.exit(1);
});

async function processDir(dir: string, processor: Processor) {
    const files = fs.readdirSync(dir, { withFileTypes: true });
    const sidecars = new Map<string, Map<string, string>>();
    const dirEntries: string[] = [];
    const fileEntries: {
        path: string;
        ext: string;
        sidecars: Map<string, string>;
    }[] = [];
    for (const file of files) {
        const _file = path.join(dir, file.name);
        const ext = path.extname(file.name);
        const base = path.basename(file.name, ext);
        let sidecar = sidecars.get(base);
        if (!sidecar) {
            sidecar = new Map();
            sidecars.set(base, sidecar);
        }
        sidecar.set(ext.toLowerCase(), _file);

        if (file.isDirectory()) {
            dirEntries.push(_file);
        } else if (file.isFile()) {
            fileEntries.push({
                path: _file,
                ext,
                sidecars: sidecar,
            });
        }
    }

    for (const file of fileEntries) {
        const stat = fs.statSync(file.path);
        await processor.process(file.path, file.ext, stat, file.sidecars);
    }

    for (const dir of dirEntries) {
        await processDir(dir, processor);
    }
}

async function processFile(dirOrFile: string, processor: Processor) {
    const stat = fs.statSync(dirOrFile);
    if (stat.isDirectory()) {
        await processDir(dirOrFile, processor);
    } else {
        await processor.process(dirOrFile, undefined, stat, new Map());
    }
}

function useProcessor(_args: Partial<typeof args>) {
    const outDir = path.resolve(args.out);
    const dryrun = _args.dryrun ?? false;

    const sourcePatterns = _args.sourcepath?.split('/') ?? [];
    const sourceRegex = sourcePatterns.map((p) => {
        const regex = /(.*)\[(.*)\]/g;
        let result = '';
        for (;;) {
            const m = regex.exec(p);
            if (!m) break;
            result += [...(m[1] ?? '')].map(() => '.').join('') + '(' + m[2] + ')';
        }
        if (!result) return undefined;
        result = '^' + result + '$';
        return new RegExp(result);
    });
    const targetPatterns = _args.targetpath?.split('/') ?? [];

    const extensions = new Set(_args.ext ?? []);
    const targets = new Set(_args.target ?? []);
    const mkdirs = new Set<string>();

    const defaultJsTime = new Date(1000, 0, 1, 0, 0, 0, 0);
    Settings.now = () => defaultJsTime.getTime();
    const defaultTime = DateTime.fromJSDate(defaultJsTime);

    function guessTimeFromPath(file: string, exifDateTime: DateTime | undefined, modifyDateTime: DateTime) {
        let pathTime = defaultTime;
        const pathSegments = file.split(path.sep);
        const pathSubgroups: (string[] | null)[] = [];

        for (let i = sourcePatterns.length - 1; i >= 0; i--) {
            const segment = pathSegments.pop();
            if (!segment) break;
            const date = DateTime.fromFormat(segment, sourcePatterns[i] ?? '');
            if (date.isValid) {
                // eslint-disable-next-line @typescript-eslint/no-loop-func
                (['year', 'month', 'day', 'hour', 'minute', 'second', 'millisecond'] as const).forEach((f) => {
                    const v = date[f];
                    const d = defaultTime[f];
                    if (v !== d) pathTime = pathTime.set({ [f]: v });
                });
            }
            const regex = sourceRegex[i];
            pathSubgroups.unshift(regex ? segment.match(regex) : null);
        }
        let pathDateTime = pathTime.toMillis() !== defaultTime.toMillis() ? pathTime : undefined;
        if (
            pathDateTime &&
            pathDateTime.hour === 0 &&
            pathDateTime.minute === 0 &&
            pathDateTime.second === 0 &&
            pathDateTime.millisecond === 0
        ) {
            // inherit time
            pathDateTime = pathDateTime.set({
                hour: exifDateTime?.hour ?? modifyDateTime.hour,
                minute: exifDateTime?.minute ?? modifyDateTime.minute,
                second: exifDateTime?.second ?? modifyDateTime.second,
                millisecond: exifDateTime?.millisecond ?? modifyDateTime.millisecond,
            });
        }
        return {
            pathDateTime,
            pathSubgroups,
        };
    }

    async function guessTime(file: string, stat: fs.Stats, sidecars: Map<string, string>) {
        const thmFile = sidecars.get('.thm');
        const exifFile = thmFile ?? file;

        const exifTags = await exiftool.read(exifFile);
        const exifTime = exifTags.CreateDate ?? exifTags.DateTimeOriginal ?? exifTags.ModifyDate;
        let exifDateTime: DateTime | undefined;
        if (exifTime && typeof exifTime === 'string') {
            exifDateTime = ExifDateTime.fromEXIF(exifTime)?.toDateTime();
        } else if (typeof exifTime !== 'string') {
            exifDateTime = exifTime?.toDateTime();
        }
        const modifyDateTime = DateTime.fromJSDate(stat.mtime);
        const { pathDateTime, pathSubgroups } = guessTimeFromPath(file, exifDateTime, modifyDateTime);

        const timeSources: Record<string, DateTime | undefined> = {
            exif: exifDateTime,
            mtime: modifyDateTime,
            path: pathDateTime,
        };
        const dateTime = _args.source?.map((t) => timeSources[t]).find((t) => t?.isValid);
        return {
            exifFile,
            exifTags,
            dateTime,
            pathSubgroups,
        };
    }

    function buildTargetPath(dateTime: DateTime, pathSubgroups: (string[] | null)[]) {
        const _pathSubgroups = [...pathSubgroups];
        const targetPaths = [];
        for (let i = targetPatterns.length - 1; i >= 0; i--) {
            const dateTimeFormat = dateTime.toFormat(targetPatterns[i] ?? '');
            const pathSubgroup = _pathSubgroups.pop() ?? null;
            const regex = /(.*)\[\$(\d+)\]/g;
            let resultPath = '';
            for (;;) {
                const lastIndex = regex.lastIndex;
                const m = regex.exec(dateTimeFormat);
                if (!m) {
                    resultPath += dateTimeFormat.substring(lastIndex);
                    break;
                }
                resultPath += (m[1] ?? '') + (pathSubgroup?.[Number(m[2])] ?? '');
            }
            targetPaths.unshift(resultPath);
        }
        return path.join(outDir, ...targetPaths);
    }

    async function process(file: string, ext: string | undefined, stat: fs.Stats, sidecars: Map<string, string>) {
        const extName = ext ?? path.extname(file);
        if (extensions.size && !extensions.has(extName.toLowerCase())) {
            console.log(`Skip ${file}`);
            return;
        }

        const { exifFile, dateTime, pathSubgroups } = await guessTime(file, stat, sidecars);
        if (!dateTime) {
            console.log(`No time for ${file}`);
            return;
        }

        const targetPath = buildTargetPath(dateTime, pathSubgroups);
        const dir = path.dirname(targetPath);
        if (!mkdirs.has(dir)) {
            fs.mkdirSync(dir, { recursive: true });
            mkdirs.add(dir);
        }
        console.log(`${file} -> ${targetPath} (${dateTime.toISO()})`);
        if (!dryrun) {
            fs.copyFileSync(file, targetPath);
        }

        let exifTargetPath: string | undefined;
        if (exifFile && exifFile !== file) {
            const exifExt = path.extname(exifFile);
            const ext = path.extname(targetPath);
            const base = path.basename(targetPath, ext);
            exifTargetPath = path.join(dir, base + exifExt);
            console.log(`${exifFile} -> ${exifTargetPath} (${dateTime.toISO()})`);
            if (!dryrun) {
                fs.copyFileSync(exifFile, exifTargetPath);
            }
        }

        if (!dryrun && targets.has('exif')) {
            try {
                await exiftool.write(
                    exifTargetPath ?? targetPath,
                    {
                        CreateDate: dateTime.toISO(),
                        DateTimeOriginal: dateTime.toISO(),
                    },
                    { writeArgs: ['-overwrite_original'] }
                );
            } catch (err) {}
        }

        // after exif
        if (!dryrun && targets.has('mtime')) {
            fs.utimesSync(targetPath, stat.atime, dateTime.toJSDate());
            if (exifTargetPath) {
                fs.utimesSync(exifTargetPath, stat.atime, dateTime.toJSDate());
            }
        }
    }

    return {
        process,
    };
}
type Processor = ReturnType<typeof useProcessor>;
