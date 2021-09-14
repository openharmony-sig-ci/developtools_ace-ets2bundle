/*
 * Copyright (c) 2021 Huawei Device Co., Ltd.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import ts from 'typescript';

import {
  COMPONENT_BUILD_FUNCTION,
  BASE_COMPONENT_NAME,
  ATTRIBUTE_ANIMATETO,
  GLOBAL_CONTEXT,
  CREATE_CONSTRUCTOR_PARAMS,
  COMPONENT_CONSTRUCTOR_UPDATE_PARAMS,
  COMPONENT_CONSTRUCTOR_DELETE_PARAMS,
  CREATE_CONSTRUCTOR_SUBSCRIBER_MANAGER,
  ABOUT_TO_BE_DELETE_FUNCTION_ID,
  CREATE_CONSTRUCTOR_GET_FUNCTION,
  CREATE_CONSTRUCTOR_DELETE_FUNCTION,
  FOREACH_OBSERVED_OBJECT,
  FOREACH_GET_RAW_OBJECT,
  COMPONENT_BUILDER_DECORATOR,
  COMPONENT_TRANSITION_FUNCTION,
  COMPONENT_CREATE_FUNCTION,
  GEOMETRY_VIEW
} from './pre_define';
import {
  BUILDIN_STYLE_NAMES,
  CUSTOM_BUILDER_METHOD
} from './component_map';
import {
  componentCollection,
  linkCollection
} from './validate_ui_syntax';
import {
  addConstructor,
  getInitConstructor
} from './process_component_constructor';
import {
  ControllerType,
  processMemberVariableDecorators,
  UpdateResult,
  stateObjectCollection,
  curPropMap
} from './process_component_member';
import {
  processComponentBuild,
  processComponentBlock
} from './process_component_build';
import {
  LogType,
  LogInfo,
  hasDecorator
} from './utils';

export function processComponentClass(node: ts.ClassDeclaration, context: ts.TransformationContext,
  log: LogInfo[], program: ts.Program): ts.ClassDeclaration {
  validateInheritClass(node, log);
  const memberNode: ts.ClassElement[] =
    processMembers(node.members, node.name, context, log, program);
  return ts.factory.updateClassDeclaration(node, undefined, node.modifiers, node.name,
    node.typeParameters, updateHeritageClauses(node), memberNode);
}

type BuildCount = {
  count: number;
}

function processMembers(members: ts.NodeArray<ts.ClassElement>, parentComponentName: ts.Identifier,
  context: ts.TransformationContext, log: LogInfo[], program: ts.Program): ts.ClassElement[] {
  const buildCount: BuildCount = { count: 0 };
  let ctorNode: any = getInitConstructor(members);
  const newMembers: ts.ClassElement[] = [];
  const watchMap: Map<string, ts.Node> = new Map();
  const updateParamsStatements: ts.Statement[] = [];
  const deleteParamsStatements: ts.PropertyDeclaration[] = [];
  const checkController: ControllerType =
    { hasController: !componentCollection.customDialogs.has(parentComponentName.getText()) };
  members.forEach((item: ts.ClassElement) => {
    let updateItem: ts.ClassElement;
    if (ts.isPropertyDeclaration(item)) {
      const result: UpdateResult = processMemberVariableDecorators(parentComponentName, item,
        ctorNode, watchMap, checkController, log, program, context);
      if (result.isItemUpdate()) {
        updateItem = result.getProperity();
      } else {
        updateItem = item;
      }
      if (result.getVariableGet()) {
        newMembers.push(result.getVariableGet());
      }
      if (result.getVariableSet()) {
        newMembers.push(result.getVariableSet());
      }
      if (result.isCtorUpdate()) {
        ctorNode = result.getCtor();
      }
      if (result.getUpdateParams()) {
        updateParamsStatements.push(result.getUpdateParams());
      }
      if (result.isDeleteParams()) {
        deleteParamsStatements.push(item);
      }
      if (result.getControllerSet()) {
        newMembers.push(result.getControllerSet());
      }
    }
    if (ts.isMethodDeclaration(item) && item.name) {
      updateItem =
        processComponentMethod(item, parentComponentName, context, log, buildCount);
    }
    if (updateItem) {
      newMembers.push(updateItem);
    }
  });
  validateBuildMethodCount(buildCount, parentComponentName, log);
  validateHasController(parentComponentName, checkController, log);
  newMembers.unshift(addDeleteParamsFunc(deleteParamsStatements));
  newMembers.unshift(addUpdateParamsFunc(updateParamsStatements));
  newMembers.unshift(addConstructor(ctorNode, watchMap));
  return newMembers;
}

function processComponentMethod(node: ts.MethodDeclaration, parentComponentName: ts.Identifier,
  context: ts.TransformationContext, log: LogInfo[], buildCount: BuildCount): ts.MethodDeclaration {
  let updateItem: ts.MethodDeclaration = node;
  const name: string = node.name.getText();
  if (name === COMPONENT_BUILD_FUNCTION) {
    buildCount.count = buildCount.count + 1;
    updateItem = processBuildMember(node, context, log);
    curPropMap.clear();
  } else if (node.body && ts.isBlock(node.body)) {
    if (name === COMPONENT_TRANSITION_FUNCTION) {
      updateItem = ts.factory.updateMethodDeclaration(node, node.decorators, node.modifiers,
        node.asteriskToken, node.name, node.questionToken, node.typeParameters, node.parameters,
        node.type, processComponentBlock(node.body, false, log, true));
    } else if (hasDecorator(node, COMPONENT_BUILDER_DECORATOR)) {
      CUSTOM_BUILDER_METHOD.add(name);
      updateItem = ts.factory.updateMethodDeclaration(node, undefined, node.modifiers,
        node.asteriskToken, node.name, node.questionToken, node.typeParameters, node.parameters,
        node.type, processComponentBlock(node.body, false, log));
    }
  }
  return ts.visitNode(updateItem, visitMethod);
  function visitMethod(node: ts.Node): ts.Node {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const name: string = node.expression.escapedText.toString();
      if (name === ATTRIBUTE_ANIMATETO) {
        node = processAnimateTo(node);
      }
    }
    return ts.visitEachChild(node, visitMethod, context);
  }
}

function processBuildMember(node: ts.MethodDeclaration, context: ts.TransformationContext,
  log: LogInfo[]): ts.MethodDeclaration {
  if (node.parameters.length) {
    log.push({
      type: LogType.ERROR,
      message: `The 'build' method can not have arguments.`,
      pos: node.getStart()
    });
  }
  const buildNode: ts.MethodDeclaration = processComponentBuild(node, log);
  return ts.visitNode(buildNode, visitBuild);
  function visitBuild(node: ts.Node): ts.Node {
    if (isGeometryView(node)) {
      node = processGeometryView(node as ts.ExpressionStatement, log);
    }
    if (isProperty(node)) {
      node = createReference(node as ts.PropertyAssignment);
    }
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.name) &&
      stateObjectCollection.has(node.name.escapedText.toString()) && node.parent &&
      ts.isCallExpression(node.parent) && ts.isPropertyAccessExpression(node.parent.expression) &&
      node.parent.expression.name.escapedText.toString() !== FOREACH_GET_RAW_OBJECT) {
      return ts.factory.createCallExpression(ts.factory.createPropertyAccessExpression(
        ts.factory.createIdentifier(FOREACH_OBSERVED_OBJECT),
        ts.factory.createIdentifier(FOREACH_GET_RAW_OBJECT)), undefined, [node]);
    }
    return ts.visitEachChild(node, visitBuild, context);
  }
}

function isGeometryView(node: ts.Node): boolean {
  if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)) {
    const call: ts.CallExpression = node.expression;
    const exp: ts.Expression = call.expression;
    const args: ts.NodeArray<ts.Expression> = call.arguments;
    if (ts.isPropertyAccessExpression(exp) && ts.isIdentifier(exp.expression) &&
      exp.expression.escapedText.toString() === GEOMETRY_VIEW && ts.isIdentifier(exp.name) &&
      exp.name.escapedText.toString() === COMPONENT_CREATE_FUNCTION && args && args.length === 1 &&
      (ts.isArrowFunction(args[0]) || ts.isFunctionExpression(args[0]))) {
      return true;
    }
  }
  return false;
}

function processGeometryView(node: ts.ExpressionStatement,
  log: LogInfo[]): ts.ExpressionStatement {
  const exp: ts.CallExpression = node.expression as ts.CallExpression;
  const arg: ts.ArrowFunction | ts.FunctionExpression =
    exp.arguments[0] as ts.ArrowFunction | ts.FunctionExpression;
  return ts.factory.updateExpressionStatement(node, ts.factory.updateCallExpression(exp,
    exp.expression, undefined, [ts.factory.createArrowFunction(undefined, undefined, arg.parameters,
      undefined, ts.factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
      getGeometryReaderFunctionBlock(arg, log))]));
}

function getGeometryReaderFunctionBlock(node: ts.ArrowFunction | ts.FunctionExpression,
  log: LogInfo[]): ts.Block {
  let blockNode: ts.Block;
  if (ts.isBlock(node.body)) {
      blockNode = node.body;
  } else if (ts.isArrowFunction(node) && ts.isCallExpression(node.body)) {
    blockNode = ts.factory.createBlock([ts.factory.createExpressionStatement(node.body)]);
  }
  return processComponentBlock(blockNode, false, log);
}

function updateHeritageClauses(node: ts.ClassDeclaration): ts.NodeArray<ts.HeritageClause> {
  const result:ts.HeritageClause[] = [];
  const heritageClause:ts.HeritageClause = ts.factory.createHeritageClause(
    ts.SyntaxKind.ExtendsKeyword,
    [ts.factory.createExpressionWithTypeArguments(
      ts.factory.createIdentifier(BASE_COMPONENT_NAME), [])]);

  if (node.heritageClauses) {
    result.push(...node.heritageClauses);
  }
  result.push(heritageClause);

  return ts.factory.createNodeArray(result);
}

export function isProperty(node: ts.Node): Boolean {
  if (node.parent && ts.isObjectLiteralExpression(node.parent) && node.parent.parent &&
    ts.isCallExpression(node.parent.parent) && ts.isPropertyAssignment(node) &&
    ts.isIdentifier(node.name)) {
    if (ts.isIdentifier(node.parent.parent.expression) &&
      !BUILDIN_STYLE_NAMES.has(node.parent.parent.expression.escapedText.toString()) &&
      componentCollection.customComponents.has(
        node.parent.parent.expression.escapedText.toString())) {
      return true;
    } else if (ts.isPropertyAccessExpression(node.parent.parent.expression) &&
      ts.isIdentifier(node.parent.parent.expression.expression) &&
      componentCollection.customComponents.has(
        node.parent.parent.expression.name.escapedText.toString())) {
      return true;
    }
  }
  return false;
}

export function createReference(node: ts.PropertyAssignment): ts.PropertyAssignment {
  const linkParentComponent: string[] = getParentNode(node, linkCollection).slice(1);
  const propertyName: ts.Identifier = node.name as ts.Identifier;
  let initText: string;
  if (linkParentComponent && ts.isPropertyAssignment(node) && ts.isIdentifier(propertyName) &&
    linkParentComponent.includes(propertyName.escapedText.toString())) {
    const LINK_REG: RegExp = /^\$/g;
    const initExpression: ts.Expression = node.initializer;
    if (ts.isIdentifier(initExpression) &&
      initExpression.escapedText.toString().match(LINK_REG)) {
      if (linkParentComponent.includes(propertyName.escapedText.toString())) {
        initText = initExpression.escapedText.toString().replace(LINK_REG, '');
      }
    } else if (ts.isPropertyAccessExpression(initExpression) && initExpression.expression &&
      initExpression.expression.kind === ts.SyntaxKind.ThisKeyword &&
      ts.isIdentifier(initExpression.name) &&
      initExpression.name.escapedText.toString().match(LINK_REG)) {
      if (linkParentComponent.includes(propertyName.escapedText.toString())) {
        initText = initExpression.name.escapedText.toString().replace(LINK_REG, '');
      }
    }
    if (initText) {
      node = addDoubleUnderline(node, propertyName, initText);
    }
  }
  return node;
}

function addDoubleUnderline(node: ts.PropertyAssignment, propertyName: ts.Identifier,
  initText: string): ts.PropertyAssignment {
  return ts.factory.updatePropertyAssignment(node, propertyName,
    ts.factory.createPropertyAccessExpression(ts.factory.createThis(),
      ts.factory.createIdentifier(`__${initText}`)));
}

function getParentNode(node: ts.PropertyAssignment, collection: Map<string, Set<string>>): string[] {
  const grandparentNode: ts.NewExpression = node.parent.parent as ts.NewExpression;
  const grandparentExpression: ts.Identifier | ts.PropertyAccessExpression =
    grandparentNode.expression as ts.Identifier | ts.PropertyAccessExpression;
  let parentComponent: Set<string> = new Set();
  let grandparentName: string;
  if (ts.isIdentifier(grandparentExpression)) {
    grandparentName = grandparentExpression.escapedText.toString();
    parentComponent = collection.get(grandparentName);
  } else if (ts.isPropertyAccessExpression(grandparentExpression)) {
    grandparentName = grandparentExpression.name.escapedText.toString();
    parentComponent = collection.get(grandparentName);
  } else {
    // ignore
  }
  if (!parentComponent) {
    parentComponent = new Set();
  }
  return [grandparentName, ...parentComponent];
}

function processAnimateTo(node: ts.CallExpression): ts.CallExpression {
  return ts.factory.updateCallExpression(node, ts.factory.createPropertyAccessExpression(
    ts.factory.createIdentifier(GLOBAL_CONTEXT), ts.factory.createIdentifier(ATTRIBUTE_ANIMATETO)),
  node.typeArguments, node.arguments);
}

function addUpdateParamsFunc(statements: ts.Statement[]): ts.MethodDeclaration {
  return createParamsInitBlock(COMPONENT_CONSTRUCTOR_UPDATE_PARAMS, statements);
}

function addDeleteParamsFunc(statements: ts.PropertyDeclaration[]): ts.MethodDeclaration {
  const deleteStatements: ts.ExpressionStatement[] = [];
  statements.forEach((statement: ts.PropertyDeclaration) => {
    const name: ts.Identifier = statement.name as ts.Identifier;
    const paramsStatement: ts.ExpressionStatement = ts.factory.createExpressionStatement(
      ts.factory.createCallExpression(ts.factory.createPropertyAccessExpression(
        ts.factory.createPropertyAccessExpression(ts.factory.createThis(),
          ts.factory.createIdentifier(`__${name.escapedText.toString()}`)),
        ts.factory.createIdentifier(COMPONENT_CONSTRUCTOR_DELETE_PARAMS)), undefined, []));
    deleteStatements.push(paramsStatement);
  });
  const defaultStatement: ts.ExpressionStatement =
    ts.factory.createExpressionStatement(ts.factory.createCallExpression(
      ts.factory.createPropertyAccessExpression(
        ts.factory.createCallExpression(ts.factory.createPropertyAccessExpression(
          ts.factory.createIdentifier(CREATE_CONSTRUCTOR_SUBSCRIBER_MANAGER),
          ts.factory.createIdentifier(CREATE_CONSTRUCTOR_GET_FUNCTION)), undefined, []),
        ts.factory.createIdentifier(CREATE_CONSTRUCTOR_DELETE_FUNCTION)),
      undefined, [ts.factory.createCallExpression(ts.factory.createPropertyAccessExpression(
        ts.factory.createThis(), ts.factory.createIdentifier(ABOUT_TO_BE_DELETE_FUNCTION_ID)),
      undefined, [])]));
  deleteStatements.push(defaultStatement);
  const deleteParamsMethod: ts.MethodDeclaration =
    createParamsInitBlock(COMPONENT_CONSTRUCTOR_DELETE_PARAMS, deleteStatements);
  return deleteParamsMethod;
}

function createParamsInitBlock(express: string, statements: ts.Statement[]): ts.MethodDeclaration {
  const methodDeclaration: ts.MethodDeclaration = ts.factory.createMethodDeclaration(undefined,
    undefined, undefined, ts.factory.createIdentifier(express), undefined, undefined,
    [ts.factory.createParameterDeclaration(undefined, undefined, undefined,
      express === COMPONENT_CONSTRUCTOR_DELETE_PARAMS ? undefined :
        ts.factory.createIdentifier(CREATE_CONSTRUCTOR_PARAMS), undefined, undefined, undefined)],
    undefined, ts.factory.createBlock(statements, true));
  return methodDeclaration;
}

function validateBuildMethodCount(buildCount: BuildCount, parentComponentName: ts.Identifier,
  log: LogInfo[]): void {
  if (buildCount.count !== 1) {
    log.push({
      type: LogType.ERROR,
      message: `struct '${parentComponentName.getText()}' must be at least or at most one 'build' method.`,
      pos: parentComponentName.getStart()
    });
  }
}

function validateInheritClass(node: ts.ClassDeclaration, log: LogInfo[]): void {
  if (node.heritageClauses) {
    log.push({
      type: LogType.ERROR,
      message: '@Component should not be inherit other Classes.',
      pos: node.heritageClauses.pos
    });
  }
}

function validateHasController(componentName: ts.Identifier, checkController: ControllerType,
  log: LogInfo[]): void {
  if (!checkController.hasController) {
    log.push({
      type: LogType.ERROR,
      message: '@CustomDialog component should have a property of the CustomDialogController type.',
      pos: componentName.pos
    });
  }
}
