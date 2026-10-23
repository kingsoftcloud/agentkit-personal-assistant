import os
import sys
import tarfile

root, archive = sys.argv[1:]
with tarfile.open(archive, 'w') as output:
    for base, dirs, files in os.walk(root):
        dirs.sort()
        files.sort()
        for name in dirs + files:
            path = os.path.join(base, name)
            arcname = os.path.relpath(path, root)
            info = output.gettarinfo(path, arcname=arcname)
            info.uid = info.gid = 0
            info.uname = info.gname = ''
            info.mtime = 0
            if info.isfile():
                with open(path, 'rb') as stream:
                    output.addfile(info, stream)
            else:
                output.addfile(info)
