import ts from 'typescript';

const config = ts.readConfigFile('tsconfig.json', ts.sys.readFile);
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, '.');
const program = ts.createProgram(parsed.fileNames, parsed.options);
const checker = program.getTypeChecker();
let failed = false;
for (const source of program.getSourceFiles().filter(file => !file.isDeclarationFile)) {
  function visit(node: ts.Node) {
    if (node.kind === ts.SyntaxKind.AnyKeyword || (ts.isAsExpression(node) && checker.getTypeAtLocation(node).flags & ts.TypeFlags.Any)) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart());
      console.error(`${source.fileName}:${line + 1}: any is not allowed`);
      failed = true;
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}
if (failed) process.exitCode = 1;
