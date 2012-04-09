var fs = require('fs');
var async = require('async');
var crypto = require('crypto');
var zlib = require('zlib');
var path = require('path');
var _ = require('underscore');

var init = function(callback) {
    fs.mkdir('pages.git', function(err) {   // ToDo: pages.git 상수로 뽑자.
        if (err) {
            if (err.code == 'EEXIST') {
                callback(new Error("pages.git already exists"));
            } else {
                throw err;
            }
        } else {
            async.series([
                async.apply(async.map, ['pages.git/objects', 'pages.git/refs'],fs.mkdir),
                async.apply(fs.mkdir, 'pages.git/refs/heads'),
                async.apply(fs.writeFile, 'pages.git/HEAD','ref: refs/heads/master'),
            ], callback
            );
        }
    });
}

var _createBlob = function(content) {
    return 'blob ' + content.length + '\0' + content;   // ToDo: NUL상수화?
}

var _sha1sum = function(data) {     // ToDo: sha1sum, digest 혼용사용? hash
    return crypto.createHash('sha1').update(data, 'binary').digest('hex');
}

var _createObjectBucket = function(digest, callback) { 
    var bucketPath = 'pages.git/objects/' + digest.substr(0,2);
    fs.mkdir(bucketPath, function(err) {
        callback(err, bucketPath);
    });
}

var _getTreeContentLength = function(tree) {
    var result = 0;  
    var SHA1SUM_DIGEST_BINARY_LENGTH = 20;
    var MODE_LENGTH = '100644'.length;

    _.each(tree, function(blobId, blobName) {
       result += MODE_LENGTH + ' '.length + blobName.length + '\0'.length + SHA1SUM_DIGEST_BINARY_LENGTH;
    });

    return result;
}

var _createTree = function (tree) { // ToDo: _serializeTree
    var offset = 0;
    var SHA1SUM_DIGEST_BINARY_LENGTH = 20;
    var length = _getTreeContentLength(tree);
    var header = "tree " + length + "\0";
    var content = new Buffer(length + header.length);
    content.write(header);
    offset += header.length;

    _.each(tree, function(blobId, blobName) {
        var entry = "100644 "+blobName+"\0";
        content.write(entry, offset);
        offset += entry.length;         // ToDo: slice 로 변경?
        content.write(blobId, offset, SHA1SUM_DIGEST_BINARY_LENGTH, 'hex');
        offset += SHA1SUM_DIGEST_BINARY_LENGTH;
    });

    return content;
}

var _storeObject = function(raw, callback) {     // ToDo: raw -> serialized
    var digest = this._sha1sum(raw);
    var self = this;
    zlib.deflate(raw, function (err, deflatedObject) {
        self._createObjectBucket(digest, function(err, bucketPath) {
            var objectPath = path.join(bucketPath, digest.substr(2));
            fs.writeFile(objectPath, deflatedObject, function (err) {
                callback(err, digest);
            });
        });
    });
}


var _getCommitIdFromHEAD = function (callback) {
    if(path.existsSync('pages.git/HEAD')) {
        var data = fs.readFileSync('pages.git/HEAD');  // ToDo: windows file system 문제. 이슈 url 달 것.
        // ToDo: data를 assert 하는 코드를 넣어 놓자
        var ref = path.join('pages.git/', data.toString().substr(5));
        if (path.existsSync(ref)) {
            var id = fs.readFileSync(ref);  // ToDo: bug in windows...
            callback(null, id);
        } else {
            callback(new Error(ref + ' does not exist'));
        }

    } else {
        callback(new Error('HEAD does not exist'));
    }
}

var createCommit = function (commit) {      // ToDo: _serializeCommit 
    var raw = '';

    raw += 'tree ' + commit.tree +'\n';
    if (commit.parent) {
        raw += 'parent ' + commit.parent + '\n';
    }
    raw += 'author ' + commit.author + '\n';
    raw += 'committer ' + commit.committer + '\n\n';
    raw += commit.message;

    return 'commit ' + raw.length + '\0' + raw;
}

var _storeFiles = function(files, callback){
    var gitfs = this;
    var tree = {};
    async.forEach(_.keys(files), function (filename, cb) {
        gitfs._storeObject(gitfs._createBlob(files[filename]), function (err, sha1sum) {
            tree[filename] = sha1sum;
            cb(err);
        });
    }, function (err) {
        callback(err, tree);
    })
}

var _createCommitFromTree = function(commitData, tree, callback) {
    var gitfs = this;

    gitfs._storeObject(gitfs._createTree(tree), function(err, sha1sum) {
        commitData.tree = sha1sum;
        gitfs._storeObject(gitfs.createCommit(commitData), function(err, sha1sum) {
            fs.writeFile('pages.git/refs/heads/master', sha1sum, function(err) {
                callback(err, sha1sum);
            });
        });
    });
}

var commit = function(commit, callback) {  // ToDo: commit -> request, request model 정의한다.
    var tree = {};
    var gitfs = this;
    var unixtime = Math.round(new Date().getTime() / 1000);
    var commitData = {
        author: commit.author.name + ' <' + commit.author.mail + '> ' + unixtime + ' ' + commit.author.timezone,
        committer: commit.committer.name + ' <' + commit.committer.mail + '> ' + unixtime + ' ' + commit.committer.timezone,
        message: commit.message
    }

    async.series({
        storeFiles: function(cb) {
           gitfs._storeFiles(commit.files, function(err, data){
               tree = data;
               cb(err);
           });
        },
        storeCommit: function(cb) {
            gitfs._getCommitIdFromHEAD(function(err, parentId) {
                if (parentId) {
                    commitData.parent = parentId;
                    gitfs.readObject(parentId.toString(), function(err, parentCommit) {
                        gitfs.readObject(parentCommit.tree, function(err, parentTree) {
                            tree = _.extend(parentTree, tree);
                            gitfs._createCommitFromTree(commitData, tree, cb);
                        });
                    });
                } else {
                    gitfs._createCommitFromTree(commitData, tree, cb);
                }
            });
        }
    }, function(err, result) { callback(err, result.storeCommit); } );
}

var _getObjectPath = function(id) {
    return path.join('pages.git', 'objects', id.substr(0, 2), id.substr(2));
}

var _parseCommitBody = function(buffer) {
    //             /tree 635a6d85573c97658e6cd4511067f2e4f3fe48cb
    // fieldPart --|parent 0cc71c0002496eccbe919c2e5f4c0616f9f2e611
    //             |author Yi, EungJun <semtlenori@gmail.com> 1333091842 +0900
    //             \committer Yi, EungJun <semtlenori@gmail.com> 1333091842 +0900
    //
    //   message -- Remove duplication between gitfs.createTreeRaw() and its test.

    var commit = {};
    var parts = buffer.toString('utf8').split('\n\n');
    var fieldPart = parts[0];
    commit.message = parts[1];

    fieldPart.split('\n').forEach(function (line) {
        // tree      635a6d85573c97658e6cd4511067f2e4f3fe48cb
        // parent    0cc71c0002496eccbe919c2e5f4c0616f9f2e611
        // author    Yi, EungJun <semtlenori@gmail.com> 1333091842 +0900
        // committer Yi, EungJun <semtlenori@gmail.com> 1333091842 +0900
        // \_______/ \_________________________________________________/
        //     |                          |
        // category                      data

        var index = line.indexOf(' ');
        var category = line.substr(0, index);
        var data = line.substr(index + 1);
        switch(category) {
            case 'tree':
            case 'parent':
                commit[category] = data
                break;
            case 'author':
            case 'committer':
                var matches = data.match(/^(.*?) <([^<>]*)> (\d*) (.\d*)/);
                commit[category] = {
                    name: matches[1],
                    mail: matches[2],
                    unixtime: matches[3],
                    timezone: matches[4],
                }
                break;
        }
    });

    return commit;
}

var _parseTreeBody = function(buffer) {
    // tree = {
    //     <filename>: <sha1sum>,
    //     ...
    // }
    var tree = {};
    for (var i = 0; i < buffer.length; i++) {
        if (buffer.readInt8(i) == 0) {
            var filename = buffer.toString('utf8', 0, i).split(' ')[1];
            var sha1sum = buffer.slice(i + 1, i + 1 + 20).toString('hex');
            tree[filename] = sha1sum;
            buffer = buffer.slice(i + 1 + 20);
            i = 0;
        }
    }
    return tree;
}

var readObject = function(id, callback) {
    if (!id) {
        throw new Error("object id is empty: " + id);
    }
    zlib.inflate(fs.readFileSync(_getObjectPath(id)), function(err, result) {
        var header = result.toString().split('\0', 1)[0];
        var body = result.slice(header.length + 1);
        var headerFields = header.split(' ');
        var type = headerFields[0];
        var object;
        if (type == 'commit') {
                object = _parseCommitBody(body);
        } else if (type == 'tree') {
                object = _parseTreeBody(body);
        } else {
                object = body;
        }
        callback(err, object);
    });
}

var show = function(filename, callback) {
    var gitfs = this;
    this._getCommitIdFromHEAD(function(err, id) {
        gitfs.readObject(id.toString(), function(err, commit) {
            gitfs.readObject(commit.tree, function(err, tree) {
                if (tree[filename]) {
                    gitfs.readObject(tree[filename], function(err, content) {
                        callback(err, content);
                    });
                } else {
                    callback(new Error("'" + filename + "' not found in the commit " + id.toString()));
                }
            });
        });
    });
}

var log_from = function(filename, from, previousBlobId, callback) {
    var gitfs = this;

    this.readObject(from, function(err, commit) {
        gitfs.readObject(commit.tree, function(err, tree) {
            var commits;

            if (tree[filename] && previousBlobId != tree[filename]) {
                commits = [commit];
                previousBlobId = tree[filename];
            } else {
                commits = [];
            }

            if (commit.parent) {
                gitfs.log_from(filename, commit.parent, previousBlobId, function(err, nextCommits) {
                    callback(err, commits.concat(nextCommits));
                });
            } else {
                callback(err, commits);
            }
        });
    });
}

var log = function(filename, callback) {
    var gitfs = this;

    this._getCommitIdFromHEAD(function(err, id) {
        gitfs.log_from(filename, id.toString(), null, callback);
    });
}

exports._storeFiles = _storeFiles;
exports._getCommitIdFromHEAD = _getCommitIdFromHEAD;
exports.init = init;
exports._createBlob = _createBlob;
exports._sha1sum = _sha1sum;
exports._createObjectBucket = _createObjectBucket;
exports._createTree = _createTree;
exports._storeObject = _storeObject;
exports._createCommitFromTree = _createCommitFromTree;
exports.createCommit = createCommit;
exports.commit = commit;
exports.readObject = readObject;
exports.show = show;
exports.log = log;
exports.log_from = log_from;