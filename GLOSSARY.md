# PuppyPad

A free homepage host in the old-web style: every member gets a site at name.yourdomain and edits its files in the browser, over the HTTP API or with the CLI.

## Language

**Site**:
A member's homepage: one folder of files served at its own subdomain. A login has one site, and supporters may have up to five.
_Avoid_: account (that is the login), page

**Site files**:
The module that owns a site's folder and every change to it: writes, deletes, moves, renames and removal, with the limits, phishing check, file history and feed event each change brings.
_Avoid_: storage, uploads
