import fs from 'node:fs';
import path from 'node:path';

import { ExifDateTime, exiftool } from 'exiftool-vendored';
import { DateTime, Settings } from 'luxon';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

// ts-node datetool.ts --dryrun --
// node --loader ts-node/esm --inspect-brk datetool.ts --dryrun --
// node --loader ts-node/esm --inspect-brk datetool.ts --source exif path mtime --target mtime --sourcepattern "([0-9_]+).*/(?:[A-Za-z]+[_-])?([0-9]+)[_-]([0-9]+)(\\..*)" --sourcepath '$1/$1_$2=yyyy_MM_dd/yyyyMMdd_HHmmss' --targetpath "yyyy/yyyyMM/yyyyMMdd_HHmmss'\$3'" --out ../photo-sorted --dryrun --
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
    .option('sourcepattern', {
        string: true,
        requiresArg: true,
        default: '([0-9]+).*/.*',
        // ([0-9_]+).*/(?:[A-Za-z]+[_-])?([0-9]+)[_-]([0-9]+)(\..*)
    })
    .option('sourcepath', {
        string: true,
        requiresArg: true,
        default: '$1/=yyyyMMdd/',
        // $1/$1_$2=yyyy_MM_dd/yyyyMMdd_HHmmss
    })
    .option('targetpath', {
        string: true,
        requiresArg: true,
        default: "yyyy/yyyyMMdd/'$&'",
        // yyyy/yyyyMM/yyyyMMdd_HHmmss'\$3'
    })
    .option('ext', {
        array: true,
        string: true,
        requiresArg: true,
        default: ['.jpg', '.png', '.mts', '.avi', '.mp4'],
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
    try {
        const files = args._;
        for (const file of files) {
            const dirOrFile = path.resolve(String(file));
            const stat = fs.statSync(dirOrFile);
            if (stat.isDirectory()) {
                const processor = useProcessor(args, dirOrFile);
                await processDir(dirOrFile, processor);
            } else {
                const processor = useProcessor(args, path.dirname(dirOrFile));
                await processor.process(dirOrFile, undefined, stat, new Map());
            }
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

function useProcessor(_args: Partial<typeof args>, baseDir: string) {
    const outDir = path.resolve(args.out);
    const dryrun = _args.dryrun ?? false;

    const sourceRegex = (_args.sourcepattern?.split('/') ?? []).map((p) => (p ? new RegExp('^' + p + '$') : undefined));
    const index0 = _args.sourcepath?.lastIndexOf('=') ?? -1;
    const sourceSubst = (index0 > 0 ? _args.sourcepath?.substring(0, index0) : undefined)?.split('/') ?? [];
    const sourcePatterns = _args.sourcepath?.substring(index0 + 1).split('/') ?? [];
    const targetPatterns = _args.targetpath?.split('/') ?? [];

    const extensions = new Set(_args.ext ?? []);
    const targets = new Set(_args.target ?? []);
    const mkdirs = new Set<string>();

    const defaultJsTime = new Date(2000, 0, 1, 0, 0, 0, 0);
    Settings.now = () => defaultJsTime.getTime();
    const defaultTime = DateTime.fromJSDate(defaultJsTime);

    function guessTimeFromPath(pathSegments: string[], exifDateTime: DateTime | undefined, modifyDateTime: DateTime) {
        let pathTime = defaultTime;
        const _pathSegments = [...pathSegments];
        const _sourceRegex = [...sourceRegex];
        const _sourceSubst = [...sourceSubst];
        const _sourcePatterns = [...sourcePatterns];
        for (;;) {
            const segment = _pathSegments.pop();
            if (segment === undefined) break;
            const pattern = _sourcePatterns.pop();
            if (pattern === undefined) break;

            const regex = _sourceRegex.pop();
            const subst = _sourceSubst.pop();
            if (!pattern) continue;
            const subgroup = regex ? segment.replace(regex, subst ?? '') : segment;
            const date = DateTime.fromFormat(subgroup, pattern);
            if (date.isValid) {
                // eslint-disable-next-line @typescript-eslint/no-loop-func
                (['year', 'month', 'day', 'hour', 'minute', 'second', 'millisecond'] as const).forEach((f) => {
                    const v = date[f];
                    const d = defaultTime[f];
                    if (v !== d) pathTime = pathTime.set({ [f]: v });
                });
            }
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
        };
    }

    async function guessTime(file: string, pathSegments: string[], stat: fs.Stats, sidecars: Map<string, string>) {
        const thmFile = sidecars.get('.thm');
        const exifFile = thmFile ?? file;

        const exifTags = await exiftool.read(exifFile);
        const exifTime = exifTags.DateTimeOriginal ?? exifTags.ModifyDate ?? exifTags.CreateDate;
        let exifDateTime: DateTime | undefined;
        if (exifTime && typeof exifTime === 'string') {
            exifDateTime = ExifDateTime.fromEXIF(exifTime)?.toDateTime();
        } else if (typeof exifTime !== 'string') {
            exifDateTime = exifTime?.toDateTime();
        }
        const modifyDateTime = DateTime.fromJSDate(stat.mtime);
        const { pathDateTime } = guessTimeFromPath(pathSegments, exifDateTime, modifyDateTime);

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
        };
    }

    function buildTargetPath(pathSegments: string[], dateTime: DateTime) {
        const _pathSegments = [...pathSegments];
        const _sourceRegex = [...sourceRegex];
        const _targetPatterns = [...targetPatterns];
        const targetPaths = [];
        for (;;) {
            const segment = _pathSegments.pop();
            if (segment === undefined) break;
            const pattern = _targetPatterns.pop();
            if (pattern === undefined) break;

            const regex = _sourceRegex.pop();
            let resultPath = regex ? segment.replace(regex, pattern) : pattern || segment;
            resultPath = dateTime.toFormat(resultPath);
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

        const pathSegments = file.split(path.sep);
        const { exifFile, dateTime } = await guessTime(file, pathSegments, stat, sidecars);
        if (!dateTime) {
            console.log(`No time for ${file}`);
            return;
        }

        const targetPath = buildTargetPath(pathSegments, dateTime);
        const dir = path.dirname(targetPath);
        if (!dryrun && !mkdirs.has(dir)) {
            fs.mkdirSync(dir, { recursive: true });
            mkdirs.add(dir);
        }
        console.log(`${path.relative(baseDir, file)} -> ${path.relative(outDir, targetPath)} (${dateTime.toISO()})`);
        if (!dryrun) {
            if (fs.existsSync(targetPath)) {
                console.log(`Exists ${targetPath}`);
                return;
            }
            fs.copyFileSync(file, targetPath);
        }

        let exifTargetPath: string | undefined;
        if (exifFile && exifFile !== file) {
            const exifExt = path.extname(exifFile);
            const ext = path.extname(targetPath);
            const base = path.basename(targetPath, ext);
            exifTargetPath = path.join(dir, base + exifExt);
            console.log(
                `${path.relative(baseDir, exifFile)} -> ${path.relative(outDir, exifTargetPath)} (${dateTime.toISO()})`
            );
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
        if (!dryrun) {
            const mtime = targets.has('mtime') ? dateTime.toJSDate() : stat.mtime;
            fs.utimesSync(targetPath, stat.atime, mtime);
            if (exifTargetPath) {
                fs.utimesSync(exifTargetPath, stat.atime, mtime);
            }
        }
    }

    return {
        process,
    };
}
type Processor = ReturnType<typeof useProcessor>;
