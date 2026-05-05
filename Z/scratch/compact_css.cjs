const fs = require('fs');
const path = process.argv[2];
if (!path) process.exit(1);

let content = fs.readFileSync(path, 'utf8');

// 1. Remove unnecessary whitespace around braces and semicolons
content = content.replace(/\s*{\s*/g, ' { ');
content = content.replace(/\s*;\s*/g, '; ');
content = content.replace(/\s*}\s*/g, ' }\n');
content = content.replace(/:\s+/g, ': ');

// 2. Clean up multiple spaces and empty lines
content = content.replace(/ +/g, ' ');
content = content.replace(/\n\s*\n/g, '\n');

// 3. Special handling for media queries or nested blocks if any
// (Though the user example shows simple rules)
// Let's refine the logic to keep comments on their own lines
const lines = content.split('\n');
const result = lines.map(line => {
    if (line.trim().startsWith('/*')) return line.trim();
    if (line.includes('{') && line.includes('}')) {
        return line.trim();
    }
    return line;
}).filter(l => l).join('\n');

fs.writeFileSync(path, result);
