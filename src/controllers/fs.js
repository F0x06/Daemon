'use strict';

/**
 * Pterodactyl - Daemon
 * Copyright (c) 2015 - 2016 Dane Everitt <dane@daneeveritt.com>
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
const Fs = require('fs-extra');
const Async = require('async');
const Path = require('path');
const Chokidar = require('chokidar');
const _ = require('lodash');
const Mmm = require('mmmagic');
const decompressEngine = require('decompress');
const Tar = require('tar-fs');
const RandomString = require('randomstring');

const Magic = Mmm.Magic;
const Mime = new Magic(Mmm.MAGIC_MIME_TYPE);

class FileSystem {
    constructor(server) {
        this.server = server;

        const Watcher = Chokidar.watch(this.server.configLocation, {
            persistent: true,
            awaitWriteFinish: false,
        });

        Watcher.on('change', () => {
            if (this.server.knownWrite !== true) {
                this.server.log.debug('Detected remote file change, updating JSON object correspondingly.');
                Fs.readJson(this.server.configLocation, (err, object) => {
                    if (err) {
                        // Try to overwrite those changes with the old config.
                        this.server.log.warn(err, 'An error was detected with the changed file, attempting to undo the changes.');
                        this.server.knownWrite = true;
                        Fs.writeJson(this.server.configLocation, this.server.json, writeErr => {
                            if (!writeErr) {
                                this.server.log.debug('Successfully undid those remote changes.');
                            } else {
                                this.server.log.fatal(writeErr, 'Unable to undo those changes, this could break the daemon badly.');
                            }
                        });
                    } else {
                        this.server.json = object;
                    }
                });
            }
            this.server.knownWrite = false;
        });
    }

    isSelf(moveTo, moveFrom) {
        const target = this.server.path(moveTo);
        const source = this.server.path(moveFrom);

        if (!_.startsWith(target, source)) {
            return false;
        }

        const end = target.slice(source.length);
        if (!end) {
            return true;
        }

        return _.startsWith(end, '/');
    }

    write(file, data, next) {
        Async.series([
            callback => {
                this.server.knownWrite = true;
                callback();
            },
            callback => {
                Fs.outputFile(this.server.path(file), data, callback);
            },
        ], next);
    }

    read(file, next) {
        Fs.stat(this.server.path(file), (err, stat) => {
            if (err) return next(err);
            if (!stat.isFile()) {
                return next(new Error('The file requested does not appear to be a file.'));
            }
            if (stat.size > 10000000) {
                return next(new Error('This file is too large to open.'));
            }
            Fs.readFile(this.server.path(file), 'utf8', next);
        });
    }

    readEnd(file, bytes, next) {
        if (_.isFunction(bytes)) {
            next = bytes; // eslint-disable-line
            bytes = 80000; // eslint-disable-line
        }
        Fs.stat(this.server.path(file), (err, stat) => {
            if (err) return next(err);
            if (!stat.isFile()) {
                return next(new Error('The file requested does not appear to be a file.'));
            }
            let opts = {};
            let lines = '';
            if (stat.size > bytes) {
                opts = {
                    start: (stat.size - bytes),
                    end: stat.size,
                };
            }
            const stream = Fs.createReadStream(this.server.path(file), opts);
            stream.on('data', data => {
                lines += data;
            });
            stream.on('end', () => {
                next(null, lines);
            });
        });
    }

    delete(path, next) {
        // Safety - prevent deleting the main folder.
        if (Path.resolve(this.server.path(path)) === this.server.path()) {
            return next(new Error('You cannot delete your home folder.'));
        }
        Fs.remove(this.server.path(path), next);
    }

    copy(path, newpath, opts, next) {
        if (_.isFunction(opts)) {
            next = opts; // eslint-disable-line
            opts = {}; // eslint-disable-line
        }
        Fs.copy(this.server.path(path), this.server.path(newpath), {
            clobber: opts.clobber || false,
            preserveTimestamps: opts.timestamps || false,
        }, next);
    }

    stat(file, next) {
        Fs.stat(this.server.path(file), (err, stat) => {
            if (err) next(err);
            Mime.detectFile(this.server.path(file), (mimeErr, result) => {
                next(null, {
                    'name': (Path.parse(this.server.path(file))).base,
                    'created': stat.ctime,
                    'modified': stat.mtime,
                    'size': stat.size,
                    'directory': stat.isDirectory(),
                    'file': stat.isFile(),
                    'symlink': stat.isSymbolicLink(),
                    'mime': result || 'unknown',
                });
            });
        });
    }

    move(initial, ending, next) {
        if (!_.isArray(initial) && !_.isArray(ending)) {
            if (this.isSelf(ending, initial)) {
                return next(new Error('You cannot move a file or folder into itself.'));
            }
            Fs.move(this.server.path(initial), this.server.path(ending), { clobber: false }, err => {
                if (err && !_.startsWith(err.message, 'EEXIST:')) return next(err);
                next();
            });
        } else if (!_.isArray(initial) || !_.isArray(ending)) {
            return next(new Error('Values passed to move function must be of the same type (string, string) or (array, array).'));
        } else {
            Async.eachOfLimit(initial, 5, (value, key, callback) => {
                if (_.isUndefined(ending[key])) {
                    return callback(new Error('The number of starting values does not match the number of ending values.'));
                }

                if (this.isSelf(ending, initial)) {
                    return next(new Error('You cannot move a file or folder into itself.'));
                }
                Fs.move(this.server.path(value), this.server.path(ending[key]), { clobber: false }, err => {
                    if (err && !_.startsWith(err.message, 'EEXIST:')) return callback(err);
                    return callback();
                });
            }, next);
        }
    }

    decompress(files, next) {
        if (!_.isArray(files)) {
            const fromFile = this.server.path(files);
            const toDir = fromFile.substring(0, _.lastIndexOf(fromFile, '/'));
            decompressEngine(fromFile, toDir, {
                strip: 1,
            }).then(() => {
                next();
            }).catch(next);
        } else if (_.isArray(files)) {
            Async.eachLimit(files, 5, (file, callback) => {
                const fromFile = this.server.path(file);
                const toDir = fromFile.substring(0, _.lastIndexOf(fromFile, '/'));
                decompressEngine(fromFile, toDir, {
                    strip: 1,
                }).then(() => {
                    next();
                }).catch(callback);
            }, next);
        } else {
            return next(new Error('Invalid datatype passed to decompression function.'));
        }
    }

    // Unlike other functions, if multiple files and folders are passed
    // they will all be combined into a single archive.
    compress(files, to, next) {
        if (!_.isString(to)) {
            return next(new Error('The to field must be a string for the folder in which the file should be saved.'));
        }

        const SaveAsName = `ptdlfm.${RandomString.generate(8)}.tar`;
        if (!_.isArray(files)) {
            if (this.isSelf(to, files)) {
                return next(new Error('Unable to compress folder into itself.'));
            }

            const Stream = Fs.createWriteStream(Path.join(this.server.path(to), SaveAsName));
            Tar.pack(this.server.path(files)).pipe(Stream);
            Stream.on('error', next);
            Stream.on('close', () => {
                next(null, SaveAsName);
            });
        } else if (_.isArray(files)) {
            const FileEntries = [];
            Async.series([
                callback => {
                    Async.eachLimit(files, 5, (file, eachCallback) => {
                        // If it is going to be inside itself, skip and move on.
                        if (this.isSelf(to, file)) {
                            return eachCallback();
                        }

                        FileEntries.push(_.replace(this.server.path(file), this.server.path(), ''));
                        eachCallback();
                    }, callback);
                },
                callback => {
                    if (_.isEmpty(FileEntries)) {
                        return next(new Error('None of the files passed to the command were valid.'));
                    }

                    const Stream = Fs.createWriteStream(Path.join(this.server.path(to), SaveAsName));
                    Tar.pack(this.server.path(), {
                        entries: FileEntries,
                    }).pipe(Stream);
                    Stream.on('error', callback);
                    Stream.on('close', callback);
                },
            ], err => {
                next(err, SaveAsName);
            });
        } else {
            return next(new Error('Invalid datatype passed to decompression function.'));
        }
    }

    directory(path, next) {
        const responseFiles = [];
        Async.waterfall([
            callback => {
                Fs.stat(this.server.path(path), (err, s) => {
                    if (err) return callback(err);
                    if (!s.isDirectory()) {
                        return callback(new Error('The path requested is not a valid directory on the system.'));
                    }
                    return callback();
                });
            },
            callback => {
                Fs.readdir(this.server.path(path), callback);
            },
            (files, callback) => {
                Async.each(files, (item, eachCallback) => {
                    Async.auto({
                        do_stat: aCallback => {
                            Fs.stat(Path.join(this.server.path(path), item), (statErr, stat) => {
                                aCallback(statErr, stat);
                            });
                        },
                        do_mime: aCallback => {
                            Mime.detectFile(Path.join(this.server.path(path), item), (mimeErr, result) => {
                                aCallback(mimeErr, result);
                            });
                        },
                        do_push: ['do_stat', 'do_mime', (results, aCallback) => {
                            responseFiles.push({
                                'name': item,
                                'created': results.do_stat.birthtime,
                                'modified': results.do_stat.mtime,
                                'size': results.do_stat.size,
                                'directory': results.do_stat.isDirectory(),
                                'file': results.do_stat.isFile(),
                                'symlink': results.do_stat.isSymbolicLink(),
                                'mime': results.do_mime || 'unknown',
                            });
                            aCallback();
                        }],
                    }, eachCallback);
                }, callback);
            },
        ], (err) => {
            next(err, _.sortBy(responseFiles, [(o) => { return _.lowerCase(o.name); }, 'created'])); // eslint-disable-line
        });
    }
}

module.exports = FileSystem;
