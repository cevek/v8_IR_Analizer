const childProc = require('child_process');
const fs = require('fs');
const command = process.argv.slice(2);

namespace irParser {

    class File {
        fullname: string;
        funMap = new Map<string, Fun>();
        funIdMap = new Map<number, FunID>();
    }

    class Fun {
        name: string;
        deopt = false;
        versions: FunID[] = [];
        versionsIdMap = new Map<number, FunID>();
        didNotInlineReason = '';

        get lastVersion() {
            return this.versions[this.versions.length - 1];
        }
    }

    class FunID {
        id: number;
        file: File;
        secondId: number;
        ownerFunId: number;
        name: string;
        code: string;
        inlines: FunID[] = [];
        deopts: string[] = [];
        runtime: Runtime[] = [];
        inlinePos = 0;
        inlineFunSecondIdMap = new Map<number, FunID>();
    }

    class Runtime {
        pos: number;
        type: string;
    }

    interface Replace {
        start: number;
        end: number;
        text: string;
    }

    class Program {
        files = new Map<string, File>();
        funMap = new Map<string, Fun>();

        run() {
            if (command.indexOf('--onlyparse') > -1) {
                program.parseFiles();
            } else {
                childProc.exec('node --trace-inlining --trace-hydrogen --trace-phase=Z --trace-deopt --hydrogen-track-positions --redirect-code-traces --redirect-code-traces-to=code.asm --trace_hydrogen_file=hg.cfg ' + command.join(' '), {
                    maxBuffer: 10 * 1000 * 1000,
                }, (err: Buffer, stdout: Buffer, stderr: Buffer) => {
                    if (err) {
                        throw err;
                    }
                    const out = stdout.toString() + stderr.toString();
                    fs.writeFileSync('out.txt', out);
                    program.parseFiles();
                });
            }
        }

        parseFiles() {
            const s = fs.readFileSync('hg.cfg', 'utf8');
            const code = fs.readFileSync('code.asm', 'utf8');
            const out = fs.readFileSync('out.txt', 'utf8');
            this.parseCode(code);
            this.parseIR(s);
            this.parseDidNotInlineReasons(out);
            this.makeHTML();
        }

        parseIR(s: string) {
            const fileIRBlocks = s.split(/^begin_compilation/m);
            for (let i = 0; i < fileIRBlocks.length; i++) {
                const IRBlock = fileIRBlocks[i];
                if (IRBlock) {
                    const res = IRBlock.match(/^\s*name "(.*?):(.*?)"\s+method "(.*?):(\d+)"/);
                    const fullname = res[1];
                    const name = res[3];
                    const id = +res[4];
                    const file = this.files.get(fullname);
                    if (!file) {
                        throw new Error('No File: ' + fullname);
                    }
                    const fun = file.funMap.get(name);
                    if (!fun) {
                        throw new Error('No fun: ' + name);
                    }
                    const funID = fun.versionsIdMap.get(id);
                    if (!funID) {
                        throw new Error('No funID: ' + id);
                    }
                    const changesRegExp = /^\s+\d \d \w\d+ (\w+).*? changes\[\*\][^\n]* pos:(\d+)(?:_(\d+))? /mg;
                    let changesRes;
                    while (changesRes = changesRegExp.exec(IRBlock)) {
                        const type = changesRes[1];
                        const pos1 = +changesRes[2];
                        const pos2 = +changesRes[3];
                        if (pos2) {
                            const inlineFunID = funID.inlineFunSecondIdMap.get(pos1);
                            inlineFunID.runtime.push({pos: pos2, type: type});
                        } else {
                            funID.runtime.push({pos: pos1, type: type});
                        }
                    }
                }
            }
        }


        parseCode(s: string) {
            const fns = s.split('--- FUNCTION SOURCE ');
            for (let i = 0; i < fns.length; i++) {
                const funBlock = fns[i];
                if (funBlock) {
                    const fnRegExp = /^\s*\((.*?):(.*?)\) id\{(\d+),(\d+)\} ---\n([\s|\S]*)\n--- END ---/;
                    const res = funBlock.match(fnRegExp);
                    const filename = res[1];
                    const name = res[2];
                    const id = +res[3];
                    const secondId = +res[4];
                    const code = res[5];

                    if (secondId !== 0) {
                        const funID = new FunID();
                        funID.code = code;
                        funID.ownerFunId = id;
                        funID.name = name;

                        const file = this.files.get(filename);
                        if (!file) {
                            throw new Error(`No file: ${filename}`);
                        }
                        const ownerFunId = file.funIdMap.get(id);
                        if (!ownerFunId) {
                            throw new Error(`No ownerFunId: ${id}`);
                        }
                        ownerFunId.inlineFunSecondIdMap.set(secondId, funID);
                        funID.file = ownerFunId.file;

                        const inlineRes = funBlock.match(/INLINE \(.*?\) id\{\d+,\d+\} AS (\d+) AT <(\d+):(\d+)>/);
                        if (inlineRes) {
                            const name = inlineRes[0];
                            const secondId = +inlineRes[1];
                            const parentSecondId = +inlineRes[2];
                            const inlinePos = +inlineRes[3];
                            funID.inlinePos = inlinePos;
                            const parentFunId = parentSecondId === 0 ? ownerFunId : ownerFunId.inlineFunSecondIdMap.get(parentSecondId);
                            if (!parentFunId) {
                                throw new Error('No parentFunId: ' + parentSecondId);
                            }
                            parentFunId.inlines.push(funID);
                        }
                        continue;
                    }

                    let file = this.files.get(filename);
                    if (!file) {
                        file = new File();
                        file.fullname = filename;
                        this.files.set(filename, file);
                    }

                    let fun = file.funMap.get(name);
                    if (!fun) {
                        fun = new Fun();
                        fun.name = name;
                        file.funMap.set(name, fun);
                        this.funMap.set(name, fun);
                    }

                    let funID = fun.versionsIdMap.get(id);
                    if (!funID) {
                        funID = new FunID();
                        fun.versionsIdMap.set(id, funID);
                    }

                    fun.versions.push(funID);
                    funID.file = file;
                    funID.name = name;
                    funID.id = id;
                    funID.code = code;
                    file.funIdMap.set(id, funID);

                    const deoptRegExp = /\[deoptimizing[^:]*: begin [^ ]* (.*?)\]/g;
                    let deoptRes;
                    while (deoptRes = deoptRegExp.exec(funBlock)) {
                        funID.deopts.push(deoptRes[1]);
                    }
                    if (funID.deopts.length) {
                        fun.deopt = true;
                    }
                }
            }
        }

        parseDidNotInlineReasons(s: string) {
            const regexp = /Did not inline (.*?) called from (.*?) \((.*?)\)\./g;
            //(cumulative AST node limit reached)
            //(target text too big)
            //(target AST is too large [early])
            //(inline depth limit reached)
            //(target has context-allocated variables)
            //(target not inlineable).
            //(target is recursive).
            let res;
            while (res = regexp.exec(s)) {
                const name = res[1];
                const calledFrom = res[2];
                const reason = res[3];
                // skip env condition reasons
                if (/(cumulative|depth limit|recursive)/.test(reason)) {
                    continue;
                }
                const fun = this.funMap.get(name);
                if (fun) {
                    fun.didNotInlineReason = reason;
                }
            }
        }

        escape(str: string) {
            return str
                .replace(/>/g, '&gt;')
                .replace(/</g, '&lt;');
        }

        makeHTML() {
            const css = fs.readFileSync('style.css', 'utf8');
            let html = `<meta charset="UTF-8"><style>${css}</style><link rel="stylesheet" href="_style.css"><script src="script.js"></script>`;
            for (const [, file] of this.files) {
                html += `<div class="file-item"><div class="file-name toggle-next">${this.escape(file.fullname)}</div><div class="fn-names">`;
                for (const [, fun] of file.funMap) {
                    html += this.funHTML(fun);
                }
                html += `</div></div>`;
            }
            fs.writeFileSync('ir.html', html);
        }

        funHTML(fun: Fun) {
            let html = `<div class="fn-item ${fun.deopt ? 'fn-deopt' : ''}"><a class="fn-name" href="#${this.escape(fun.name)}" id="${this.escape(fun.name)}">${this.escape(fun.name)}:</a><div class="fn-versions">`;
            const versions = fun.versions;
            for (let i = 0; i < versions.length; i++) {
                const version = versions[i];
                html += `<div class="recompile">`;
                if (versions.length > 1) {
                    html += `<span class="recompile-title toggle-next">~recompile~</span>`;
                }
                html += `<div class="${versions.length - 1 === i ? '' : 'hidden'}">${this.funIDHTML(versions[versions.length - 1], true)}</div>`;
                const deopts = version.deopts;
                if (deopts.length) {
                    for (let j = 0; j < deopts.length; j++) {
                        const deopt = deopts[j];
                        html += `<div class="deopt">Deopt: ${this.escape(deopt)}</div>`;
                    }
                }
                html += `</div>`;
            }
            html += `</div></div>`;
            return html;
        }

        funIDHTML(funID: FunID, isTopLevel: boolean): string {
            const replaces = [];
            const code = funID.code;

            for (let i = 0; i < code.length; i++) {
                if (code[i] === '<') replaces.push({start: i, end: i + 1, text: '&lt;'});
                else if (code[i] === '>') replaces.push({start: i, end: i + 1, text: '&gt;'});
            }

            for (let i = 0; i < funID.inlines.length; i++) {
                const inlineFunID = funID.inlines[i];
                const pos = inlineFunID.inlinePos;
                const end = this.findEnd(code, pos);
                const sub = code.substring(pos, end);
                const spaces = this.getSpaceSymbolsBeforePrevNewLineOfPos(code, end);
                replaces.push({
                    start: pos,
                    end: end,
                    text: `<span class="inline toggle-next" data-title="Show inlined">${sub}</span><span class="inline-code hidden">${this.funIDHTML(inlineFunID, false)}${spaces}</span>`
                });
            }

            for (let i = 0; i < funID.runtime.length; i++) {
                const runtime = funID.runtime[i];
                const pos = runtime.pos;
                const end = this.findEnd(code, pos);
                let oldCode = (code.substring(pos, end));
                const prefix = '';//runtimeType[runtime.text] || '';
                const type = (runtime.type === 'InvokeFunction' || runtime.type === 'CallRuntime') ? 'CallWithDescriptor' : runtime.type;
                let replacedCode = `<span class="runtime ${type}" data-title="${type}">${prefix}${oldCode}</span>`;
                if (type === 'CallWithDescriptor') {
                    const linkedFun = this.funMap.get(oldCode);
                    if (linkedFun) {
                        replacedCode = `<a class="runtime ${type}" ${linkedFun.didNotInlineReason ? `did-not-inlined data-title="Did not inline: ${linkedFun.didNotInlineReason}"` : ''} href="#${oldCode}">${oldCode}</a>`;
                    }
                }
                replaces.push({start: pos, end: end, text: replacedCode});
            }
            return `<div class="code">${this.replaceCode(code, replaces)}</div>`;
        }

        getSpaceSymbolsBeforePrevNewLineOfPos(code: string, pos: number) {
            let s = '';
            for (let i = pos - 1; i >= 0; i--) {
                if (code[i] === '\n') {
                    return s;
                }
                s += ' ';
            }
            return s;
        }

        sortStart(a: { start: number }, b: { start: number }) {
            return a.start < b.start ? -1 : 1;
        }


        replaceCode(code: string, replaces: Replace[]) {
            replaces.sort(this.sortStart);
            let shift = 0;
            let prevEnd = -1;
            for (let i = 0; i < replaces.length; i++) {
                const replace = replaces[i];
                const pos = replace.start + shift;
                const end = replace.end + shift;
                if (prevEnd > pos) {
                    continue;
                }
                const replacedCode = replace.text;
                code = code.substr(0, pos) + replacedCode + code.substr(end);
                const diff = replacedCode.length - (end - pos);
                shift += diff;
                prevEnd = end + diff;
            }
            return code;
        }

        findEnd(code: string, start: number) {
            new RegExp(`(.|\n){${start}}(\w+)`);
            const sub = code.substr(start, 100);
            const m = sub.match(/^(new |[.=[ !&<>\^%+\-|]*)?[\w\d_]+]?/);
            if (m) {
                return start + m[0].length;
            }
            return start + 5;
        }
    }

    const program = new Program();
    program.run();
}