/**
 * Static sweeps for the egress test (done-whens 2 and 5), on the TypeScript
 * syntax tree rather than regexes, so comments and strings never count and
 * spacing or line breaks never hide a load or an env read.
 */
import ts from "typescript";

export interface ModuleLoads {
  /** Value module specifiers: type-only imports and exports don't count. */
  specs: string[];
  /** Loads whose module can't be read off the source: a non-literal import() or require(), createRequire. */
  dynamic: string[];
}

function parse(fileName: string, text: string): ts.SourceFile {
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function literal(node: ts.Node | undefined): string | undefined {
  if (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) return node.text;
  return undefined;
}

function allTypeOnly(elements: ts.NodeArray<ts.ImportSpecifier | ts.ExportSpecifier>): boolean {
  return elements.length > 0 && elements.every((e) => e.isTypeOnly);
}

export function moduleLoads(fileName: string, text: string): ModuleLoads {
  const specs: string[] = [];
  const dynamic: string[] = [];
  const sf = parse(fileName, text);
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const typeOnly =
        clause !== undefined &&
        (clause.isTypeOnly ||
          (clause.name === undefined &&
            clause.namedBindings !== undefined &&
            ts.isNamedImports(clause.namedBindings) &&
            allTypeOnly(clause.namedBindings.elements)));
      const spec = literal(node.moduleSpecifier);
      if (!typeOnly && spec !== undefined) specs.push(spec);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      const typeOnly =
        node.isTypeOnly ||
        (node.exportClause !== undefined && ts.isNamedExports(node.exportClause) && allTypeOnly(node.exportClause.elements));
      const spec = literal(node.moduleSpecifier);
      if (!typeOnly && spec !== undefined) specs.push(spec);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const spec = literal(node.moduleReference.expression);
      if (spec !== undefined) specs.push(spec);
      else dynamic.push(node.getText(sf));
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const isImport = callee.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(callee) && callee.text === "require";
      const isBuiltin =
        (ts.isPropertyAccessExpression(callee) && callee.name.text === "getBuiltinModule") ||
        (ts.isIdentifier(callee) && callee.text === "getBuiltinModule");
      if (isImport || isRequire || isBuiltin) {
        const spec = literal(node.arguments[0]);
        if (spec !== undefined) specs.push(spec);
        else dynamic.push(node.getText(sf));
      }
    } else if (ts.isIdentifier(node) && node.text === "createRequire") {
      dynamic.push(`createRequire at line ${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { specs, dynamic };
}

/** `node:dns/promises` -> `dns`; `@scope/pkg/sub` -> `@scope/pkg`. */
export function normaliseSpecifier(spec: string): string {
  const bare = spec.replace(/^node:/, "");
  if (bare.startsWith("@")) return bare.split("/").slice(0, 2).join("/");
  return bare.split("/")[0];
}

/** Every identifier or property name `fetch` or `doFetch`, in code (never a comment or string). */
export function fetchNames(fileName: string, text: string): string[] {
  const out: string[] = [];
  const sf = parse(fileName, text);
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && (node.text === "fetch" || node.text === "doFetch")) {
      out.push(`${node.text} at line ${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

export interface EnvReads {
  /** Names read off the env object. */
  names: string[];
  /** Uses that hide which names are read: a computed key, a spread, the object passed on. */
  opaque: string[];
}

function unwrap(node: ts.Expression): ts.Expression {
  let e = node;
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e) || ts.isSatisfiesExpression(e)) {
    e = e.expression;
  }
  return e;
}

function propertyName(node: ts.PropertyName | ts.BindingName | undefined): string | undefined {
  if (!node) return undefined;
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return undefined;
}

/**
 * Reads of the process env: `process.env.X`, `process.env["X"]`,
 * `process["env"]`, `globalThis.process.env`, aliases of `process` or its
 * env (`const p = process`, `const e = process.env`, `const { env } =
 * process`, `import { env } from "node:process"`, a parameter defaulting to
 * `process.env`), destructuring `const { X } = <env>`, and any `env.X`.
 */
export function envReads(fileName: string, text: string): EnvReads {
  const sf = parse(fileName, text);
  const processAliases = new Set<string>(["process"]);
  const envAliases = new Set<string>();
  const names: string[] = [];
  const opaque: string[] = [];
  const where = (n: ts.Node) => `line ${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;

  const isProcess = (e: ts.Expression): boolean => {
    const u = unwrap(e);
    if (ts.isIdentifier(u)) return processAliases.has(u.text);
    if (ts.isPropertyAccessExpression(u)) return u.name.text === "process" && ts.isIdentifier(u.expression) && u.expression.text === "globalThis";
    return false;
  };
  const isEnv = (e: ts.Expression): boolean => {
    const u = unwrap(e);
    if (ts.isIdentifier(u)) return envAliases.has(u.text);
    if (ts.isPropertyAccessExpression(u)) return u.name.text === "env" && isProcess(u.expression);
    if (ts.isElementAccessExpression(u)) return literal(u.argumentExpression) === "env" && isProcess(u.expression);
    return false;
  };

  // Pass 1: aliases (declarations anywhere in the file).
  const collect = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const spec = literal(node.moduleSpecifier);
      if (spec === "process" || spec === "node:process") {
        const clause = node.importClause;
        if (clause?.name) processAliases.add(clause.name.text);
        const nb = clause?.namedBindings;
        if (nb && ts.isNamespaceImport(nb)) processAliases.add(nb.name.text);
        if (nb && ts.isNamedImports(nb)) {
          for (const el of nb.elements) if ((el.propertyName ?? el.name).text === "env") envAliases.add(el.name.text);
        }
      }
    }
    if ((ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)) && node.initializer) {
      const init = node.initializer;
      if (ts.isIdentifier(node.name)) {
        if (isProcess(init)) processAliases.add(node.name.text);
        else if (isEnv(init)) envAliases.add(node.name.text);
      } else if (ts.isObjectBindingPattern(node.name) && isProcess(init)) {
        for (const el of node.name.elements) {
          if (propertyName(el.propertyName ?? el.name) === "env" && ts.isIdentifier(el.name)) envAliases.add(el.name.text);
        }
      }
    }
    ts.forEachChild(node, collect);
  };
  collect(sf);
  collect(sf); // a second pass catches an alias of an alias declared later in the file

  // Pass 2: uses.
  const visit = (node: ts.Node): void => {
    if (ts.isExpression(node) && isEnv(node) && !(ts.isIdentifier(node) && isDeclarationName(node))) {
      const parent = node.parent;
      if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
        names.push(parent.name.text);
      } else if (ts.isElementAccessExpression(parent) && parent.expression === node) {
        const key = literal(parent.argumentExpression);
        if (key !== undefined) names.push(key);
        else opaque.push(`${parent.getText(sf)} (${where(parent)})`);
      } else if (ts.isVariableDeclaration(parent) && parent.initializer === node && ts.isObjectBindingPattern(parent.name)) {
        for (const el of parent.name.elements) {
          const key = propertyName(el.propertyName ?? el.name);
          if (key !== undefined && el.dotDotDotToken === undefined) names.push(key);
          else opaque.push(`${el.getText(sf)} (${where(el)})`);
        }
      } else if (
        (ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isBindingElement(parent)) &&
        parent.initializer === node &&
        ts.isIdentifier(parent.name)
      ) {
        // An alias: its own uses are checked through envAliases.
      } else if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node) || ts.isIdentifier(node)) {
        opaque.push(`${parent.getText(sf).slice(0, 60)} (${where(node)})`);
      }
    }
    // Any `env.X`, whatever `env` is bound to (a parameter that receives process.env).
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "env" && !envAliases.has("env")) {
      names.push(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { names, opaque };
}

function isDeclarationName(id: ts.Identifier): boolean {
  const p = id.parent;
  return (
    ((ts.isVariableDeclaration(p) || ts.isParameter(p) || ts.isBindingElement(p)) && p.name === id) ||
    (ts.isImportSpecifier(p) && p.name === id) ||
    (ts.isBindingElement(p) && p.propertyName === id)
  );
}
