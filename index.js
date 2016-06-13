#! /usr/bin/node
'use strict';

var child = require('child_process'),
    chalk = require('chalk'),
    program = require('commander'),
    calls = require('./data/syscalls'),
    errors = require('./data/errno'),
    _ = require('lodash'),
    config = require('./package.json'),
    log = console.log,
    args = process.argv,
    platform = process.platform;

// CLI program configuring
program
    .version(config.version)
    .description(chalk.cyan.bold(
        'ctrace - well-formatted and improved trace system calls and signals (when the debugger does not help)'
    ))
    .option('-p, --pid [pid]', 'process id to trace')
    .option('-c, --cmd [cmd]', 'command to trace')
    .option('-f, --filter [syscall,]', 'trace syscall only from list', function(value) {
        return value.split(',');
    })
    .option('-v, --verbose', 'print all syscalls (by default only with errors)')
    .on('--help', function(){
        console.log('  Examples:');
        console.log('');
        console.log('    $ ctrace -p 2312 -v');
        console.log('    $ ctrace -c "ping google.com"');
        console.log('');
    });
program.parse(process.argv);

// Handle keyboard interrupting
function interruption() {
    log(chalk.yellow.bold('\nExecuting interrupted by signal ...'));
}
process.on('SIGTERM', interruption);
process.on('SIGINT', interruption);

// Platform specific binary and arguments
var utility = {
        darwin: { bin: 'dtruss', args: ['-e', '-f', '-L'] },
        linux: { bin: 'strace', args: ['-y', '-v', '-x', '-f', '-tt', '-T'] }
    },
    parser = { linux: parseStraceData, darwin: parseDtrussData },
    report = { syscalls: {}, total: {time: 0, count: 0, errors: 0} };

function getCommandLine() {

    // Supported only darwin (with dtruss) and linux (with strace)
    if (['darwin', 'linux'].indexOf(platform) < 0) {
        log(chalk.red.bold('Current platform not supported'));
        process.exit();
    }
    // Build command and arguments
    var args = utility[platform].args;
    if (program.cmd && typeof program.cmd == 'string') {
        args = args.concat(program.cmd.split(' '));
    } else if (program.pid) {
        args.push('-p');
        args.push(program.pid);
    } else {
        program.help();
        process.exit();
    }
    return { bin: utility[platform].bin, args: args };
}

function collectStraceOutput(syscall, result, time) {

    var exit = parseInt(result || 0, 10),
        time = parseFloat(_.trim(time, '<>'), 10);
    if (syscall) {
        if (!report.syscalls[syscall.name]) {
            report.syscalls[syscall.name] = {
                name: syscall.name, count: 0, errors: {}, timings: []
            };
        }
        var call = report.syscalls[syscall.name];
        call.count += 1;
        report.total.count += 1;
        if (time) {
            call.timings.push(time);
            report.total.time += time;
        }
        if (exit < 0) {
            var code = result.split(exit)[1].split('<')[0].trim();
            if (!call.errors[code]) {
                call.errors[code] = 1;
            } else {
                call.errors[code] += 1;
            }
            report.total.errors += 1;
        }
    }
}

function collectReport() {

    if (!report.total.count) {
        return;
    }
    var syscalls = [];
    log(chalk.white.bold(Array(100).join('-')));
    log(chalk.white.bold(
        'syscall' + Array(10).join(' ') +
        'time %' + Array(7).join(' ') +
        'second' + Array(6).join(' ') +
        'calls' + Array(15).join(' ') +
        'description'
    ));
    log(chalk.white.bold(Array(100).join('-')));
    syscalls = _.map(report.syscalls, function(syscall, name) {
        syscall.total = 0;
        // Calculate total syscalls time
        _.each(syscall.timings, function(time) {
            syscall.total += time;
        });
        syscall.percent = (syscall.total * 100 / report.total.time).toFixed(1);
        return syscall;
    }).sort(function(a, b) {
        return b.percent - a.percent;
    });
    log(
        chalk.white.bold('*'), '\t\t',
        '100', '\t  ',
        report.total.time.toFixed(6), '\t',
        report.total.count, '\t'
    );
    _.each(syscalls, function(syscall) {
        var name = syscall.name.length > 10
            ? (syscall.name.substr(0, 10) + '...')
            : syscall.name,
            doc = getSyscall(syscall.name) || {};
        log(
            chalk.white.bold(name), syscall.name.length > 6 ? '\t' : '\t\t',
            syscall.percent, '\t  ',
            syscall.total.toFixed(6), '\t',
            syscall.count, '\t',
            doc ? doc.desc : '<undocumented>'
        );
        if (syscall.errors) {
            _.each(syscall.errors, function(count, err) {
                log(chalk.red.bold('  (' + count + ') ' + err));
            });
        }
    });
    log(chalk.white.bold(Array(100).join('-')));
}

function spawn() {

    var cp, cmd = getCommandLine(), delimiter = Array(5).join('-');
    // Spawn strace with command
    cp = child.spawn(cmd.bin, cmd.args, {env: process.env});
    cp.stdout.chunks = 0;
    // Target command output on stdout, stderr output will be ignored
    cp.stdout.on('data', function(data) {
        cp.stdout.chunks++;
        log(chalk.cyan(
            delimiter + ' ^ stdout chunk{' + cp.stdout.chunks + '} ' + delimiter
        ));
        log(chalk.white.bold(data.toString()));
        log(chalk.cyan(
            delimiter + ' $ stdout chunk{' + cp.stdout.chunks + '} ' + delimiter
        ));
    });
    // Strace output on stderr
    cp.stderr.on('data', function(data) {
        data = data.toString().split('\n');
        // Parse row tails
        if (cp.stderr.tail) {
            data[0] = cp.stderr.tail + data[0];
            delete cp.stderr.tail;
        }
        if (data[data.length - 1]) {
            cp.stderr.tail = data.pop();
        }
        var irregularEnd = new RegExp('\>\d{2}', 'igm');
        // Search incompleted or irregular rows
        _.each(data, function(value, i) {
            if (!value) {
                return;
            }
            // Glue incompleted rows
            if (!value.match(/\>$/)) {
                if (value && data[i + 2]) {
                    value = value + data[i + 2];
                    data[i] = value;
                    data.splice(i + 1, 2);
                }
            }
        });
        parser[process.platform](data);
    });
    cp.on('exit', function(code, signal) {
        collectReport();
        process.exit();
    });
    return cp;
}

function getSyscall(name) {

    if (!name) {
        return;
    }
    try {
        var cleaned = _.trim(name, '_'),
            p1 = new RegExp('^' + name + '|' + name + '$', 'gi'),
            p2 = new RegExp('^' + cleaned + '|' + cleaned + '$', 'gi'),
            syscall =
                _.find(calls, function(v, k) {
                    if (!v[platform]) {
                        return false;
                    }
                    return v[platform].name === name || v[platform].name === cleaned;
                }) ||
                _.find(calls, function(v, k) {
                    if (!v[platform]) {
                        return false;
                    }
                    return v[platform].name.match(p1) || v[platform].name.match(p2);
                });
        return {
            name: name,
            // Synonym
            synonym: name != syscall[platform].name ? syscall[platform].name : '',
            // Number
            num: syscall ? syscall[platform].number : 'NULL',
            // Description
            desc: syscall ? syscall[platform].desc : 'undocumented',
            // Platfrom specific flag
            specific: syscall && _.keys(syscall).length == 1 ? platform : '',
        }
    } catch (err) {}
    return;
}

function canIPrintIt(name, exit) {

    var filtered = program.filter && program.filter.length && program.filter.indexOf(name) == -1;
    if (filtered) {
        return false;
    }
    if (platform == 'darwin') {
        return program.verbose || !(exit >= 0);
    }
    if (platform == 'linux') {
        return program.verbose || exit < 0;
    }
}

var pRegularRow = new RegExp('^(\\d{2}:|\\[).+\\d+>$'),
    pFork = new RegExp('(\\[pid\\s+\\d+\\])\\s(.+)');

function parseStraceData(data) {

    // Parse each syscall row and colorize chunks
    // Regular row pattern
    _.each(data, function (row) {
        // Ignore empty rows
        if (!row) {
            return;
        }
        // Detect unfinished and resumed rows
        var unfinished = row.match(/unfinished/),
            resumed = row.match(/resumed/);
        // Detect regular (completed) rows
        if (!row.match(pRegularRow) && !row.split('(')[0].split(' ') && !unfinished && !resumed) {
            log(chalk.grey(row.replace(/\s+/, ' ')));
            return;
        }
        // Detect syscalls from child processes
        var fork = row.match(pFork);
        // Is syscall from forked process
        if (fork) {
            row = fork[2];
            fork = fork[1].replace(/\s+/ig, ':');
        }
        // Parse unfinished call rows
        if (unfinished) {
            var _first = row.indexOf(' '),
                timestamp = row.substr(0, _first).trim(),
                name = row.substr(_first + 1, row.indexOf('(') - _first - 1).trim(),
                syscall = getSyscall(name);

            collectStraceOutput(syscall, result, time);

            if (canIPrintIt(name, exit) && syscall) {
                log(
                    fork
                        ? chalk.blue.bold(fork) + chalk.grey(' [' + timestamp + ']')
                        : chalk.grey('[' + timestamp + ']'),
                    // Name with synonyms, number, description and platform specific flag
                    chalk.magenta.bold(syscall.name + (syscall.synonym ? ' (' + syscall.synonym + ')': '')) +
                        ', ' + chalk.white.bold(syscall.num) + ' -- ' + syscall.desc + ' ' +
                        chalk.white.bold(syscall.specific),
                    chalk.white.bold(row.split(name)[1])
                );
            }
        // Parse resumed call rows
        } else if (resumed) {
            var _first = row.indexOf(' '),
                timestamp = row.substr(0, _first).trim(),
                name = row.split('<...')[1].trim().split('resumed')[0].trim(),
                syscall = getSyscall(name);

            collectStraceOutput(syscall, result, time);

            if (canIPrintIt(name, exit) && syscall) {
                log(
                    fork
                        ? chalk.blue.bold(fork) + chalk.grey(' [' + timestamp + ']')
                        : chalk.grey('[' + timestamp + ']'),
                    // Name with synonyms, number, description and platform specific flag
                    chalk.magenta.bold(syscall.name + (syscall.synonym ? ' (' + syscall.synonym + ')': '')) +
                        ', ' + chalk.white.bold(syscall.num) + ' -- ' + syscall.desc + ' ' +
                        chalk.white.bold(syscall.specific),
                    chalk.white.bold('<... ' + row.split(name)[1])
                );
            }
        } else {
            var call = row.substr(0, row.lastIndexOf(' = ')).trim(),
                _first = call.indexOf(' '), _last = call.lastIndexOf(' '),
                timestamp = call.substr(0, _first).trim(),
                // Name
                name = call.substr(_first + 1, call.indexOf('(') - _first - 1).trim(),
                // Syscall document object
                syscall = getSyscall(name),
                // Arguments
                params = call.substr(_first).replace(name, '').trim(),
                // Result and timing
                result = row.substr(row.lastIndexOf(' = ') + 2).trim(),
                _first = result.indexOf(' '), _last = result.lastIndexOf(' '),
                // Exit code
                exit = result.substr(0, _first).trim(),
                // Returned value
                value = _.trim(
                    (result.split(/\s/).length == 2) ? '' : result.substr(_first, _last).trim(), '<>'
                ),
                // Elapsed time
                time = result.substr(_last + 1).trim();

            collectStraceOutput(syscall, result, time);

            // Ignore syscalls not from the filter list
            if (canIPrintIt(name, exit) && syscall) {
                log(
                    // Split syscall from master and child processes
                    fork
                        ? chalk.blue.bold(fork) + chalk.grey(' [' + timestamp + ']')
                        : chalk.grey('[' + timestamp + ']'),
                    // Name with synonyms, number, description and platform specific flag
                    chalk.magenta.bold(syscall.name + (syscall.synonym ? ' (' + syscall.synonym + ')': '')) +
                        ', ' + chalk.white.bold(syscall.num) + ' -- ' + syscall.desc || 'undocumented' +
                        ' ' + chalk.white.bold(syscall.specific),
                    // Arguments
                    '\n\t' + chalk.grey(params),
                    // Exit code
                    chalk.white.bold('= ') + (exit < 0 ? chalk.red.bold(exit) : chalk.green.bold(exit)),
                    // Returned value
                    exit < 0 ? chalk.red.bold(value) : chalk.blue.bold(value),
                    // Elapsed time
                    chalk.cyan.bold(time)
                );
            }
        }
    });
}

function parseDtrussData(data) {
    // Parse each syscall row and colorize chunks
    _.each(data, function(row) {
        // Ignore empty rows
        if (!row) {
            return;
        }
        if (!row.match(/^\s+\d+.+\d+$/)) {
            if (row.match(/SYSCALL\(args\)/)) {
                return;
            }
            log(chalk.grey(row));
            return;
        }
        row = row.split('\t');
        var // Detect syscalls from child processes
            fork = row[0].match(/(\[pid\s+\d+\])\s(.+)/),
            // Elapsed time
            time = Number(row[0].trim().split(' ')[0]) / 1000000,
            call = row[0].trim().split(' ')[1].split('('),
            // Name
            name = call[0],
            // Arguments
            params = row[0].trim().split(name)[1],
            // Syscall document object
            syscall = getSyscall(name),
            result = row[2].trim().split('=')[1].trim().split(' '),
            // Returned value
            value = result[0],
            // Exit code
            exit = result[1],
            errno = exit.startsWith('Err') ? errors[platform][exit.split('#')[1]] : null;

        if (canIPrintIt(name, exit)) {
            log(
                // Split syscall from master and child processes
                fork ? chalk.blue.bold(fork) : '',
                // Name with synonyms, number, description and platform specific flag
                chalk.magenta.bold(syscall.name + (syscall.synonym ? ' (' + syscall.synonym + ')': '')) +
                    ' ' + chalk.white.bold(syscall.num) + ' -- ' + (syscall.desc || 'undocumented') + ' ' + chalk.white.bold(syscall.specific),
                // Arguments
                '\n\t' + chalk.grey(params),
                // Exit code
                chalk.white.bold('= ') + (!(exit >= 0)
                    ? chalk.red.bold(exit + ' ' + errno.code + ' : ' + errno.desc)
                    : chalk.blue.bold(exit)),
                // Returned value
                !(exit >= 0) ? chalk.red.bold(value) : chalk.green.bold(value),
                // Elapsed time
                chalk.cyan.bold('<' + time + '>')
            );
        }
    });
}

module.exports = function () {
    log('[' + spawn().pid + '] Trace on: ' + chalk.magenta.bold(
        program.cmd ? program.cmd : ' attach to process ' + program.pid
    ));
}
