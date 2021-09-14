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

import Stats from 'webpack/lib/Stats';
import Compiler from 'webpack/lib/Compiler';
import {
  configure,
  getLogger
} from 'log4js';
import RawSource from 'webpack-sources/lib/RawSource';

import {
  BUILDIN_STYLE_NAMES,
  EXTEND_ATTRIBUTE
} from './component_map';
import { transformLog } from './process_ui_syntax';
import {
  dollarCollection,
  componentCollection,
  moduleCollection
} from './validate_ui_syntax';
import { decoratorParamSet } from './process_component_member';
import { appComponentCollection } from './process_component_build';
import { projectConfig } from '../main';

configure({
  appenders: { 'ETS': {type: 'stderr', layout: {type: 'messagePassThrough'}}},
  categories: {'default': {appenders: ['ETS'], level: 'info'}}
});
export const logger = getLogger('ETS');

const props: string[] = [];

interface Info {
  message?: string;
  issue?: {
    message: string,
    file: string,
    location: { start?: { line: number, column: number } }
  };
}

export class ResultStates {
  private mStats: Stats;
  private mErrorCount: number = 0;
  private mWarningCount: number = 0;
  private warningCount: number = 0;
  private noteCount: number = 0;
  private red: string = '\u001b[31m';
  private yellow: string = '\u001b[33m';
  private blue: string = '\u001b[34m';
  private reset: string = '\u001b[39m';

  public apply(compiler: Compiler): void {
    compiler.hooks.done.tap('Result States', (stats: Stats) => {
      this.mStats = stats;
      this.warningCount = 0;
      this.noteCount = 0;
      if (this.mStats.compilation.errors) {
        this.mErrorCount = this.mStats.compilation.errors.length;
      }
      if (this.mStats.compilation.warnings) {
        this.mWarningCount = this.mStats.compilation.warnings.length;
      }
      props.push(...dollarCollection, ...decoratorParamSet, ...BUILDIN_STYLE_NAMES);
      this.printResult();
    });

    if (!projectConfig.isPreview) {
      compiler.hooks.compilation.tap('Collect Components And Modules', compilation => {
        compilation.hooks.additionalAssets.tapAsync('Collect Components And Modules', callback => {
          compilation.assets['./component_collection.txt'] =
            new RawSource(Array.from(appComponentCollection).join(","));
          compilation.assets['./module_collection.txt'] =
            new RawSource(moduleCollection.size === 0 ? 'NULL' : Array.from(moduleCollection).join(","));
          callback();
        });
      })
    }
  }

  private printResult(): void {
    this.printWarning();
    this.printError();
    if (this.mErrorCount + this.warningCount + this.noteCount > 0) {
      let result: string;
      let resultInfo: string = '';
      if (this.mErrorCount > 0) {
        resultInfo += `ERROR:${this.mErrorCount}`;
        result = 'FAIL ';
      } else {
        result = 'SUCCESS ';
      }
      if (this.warningCount > 0) {
        resultInfo += ` WARN:${this.warningCount}`;
      }
      if (this.noteCount > 0) {
        resultInfo += ` NOTE:${this.noteCount}`;
      }
      logger.info(this.blue, 'COMPILE RESULT:' + result + `{${resultInfo}}`, this.reset);
    } else {
      logger.info(this.blue, 'COMPILE RESULT:SUCCESS ', this.reset);
    }
  }

  private printWarning(): void {
    if (this.mWarningCount > 0) {
      const warnings: Info[] = this.mStats.compilation.warnings;
      const length: number = warnings.length;
      for (let index = 0; index < length; index++) {
        const message: string = warnings[index].message.replace(/^Module Warning\s*.*:\n/, '')
          .replace(/\(Emitted value instead of an instance of Error\) BUILD/, '');
        if (/^NOTE/.test(message)) {
          this.noteCount++;
          logger.info(this.blue, message, this.reset, '\n');
        } else {
          this.warningCount++;
          logger.warn(this.yellow, message.replace(/^WARN/, 'ETS:WARN'), this.reset, '\n');
        }
      }
      if (this.mWarningCount > length) {
        this.warningCount = this.warningCount + this.mWarningCount - length;
      }
    }
  }

  private printError(): void {
    if (this.mErrorCount > 0) {
      const errors: Info[] = [...this.mStats.compilation.errors];
      for (let index = 0; index < errors.length; index++) {
        if (errors[index].issue) {
          const position: string = errors[index].issue.location
            ? `:${errors[index].issue.location.start.line}:${errors[index].issue.location.start.column}`
            : '';
          const location: string = errors[index].issue.file + position;
          const detail: string = errors[index].issue.message;
          logger.error(this.red, 'ETS:ERROR File: ' + location, this.reset);
          logger.error(this.red, detail, this.reset, '\n');
        } else if (/BUILDERROR/.test(errors[index].message)) {
          const errorMessage: string = errors[index].message.replace(/^Module Error\s*.*:\n/, '')
            .replace(/\(Emitted value instead of an instance of Error\) BUILD/, '')
            .replace(/^ERROR/, 'ETS:ERROR');
          this.printErrorMessage(errorMessage, true, errors[index]);
        } else {
          let errorMessage: string = `${errors[index].message.replace(/\[tsl\]\s*/, '')
            .replace(/\u001b\[.*?m/g, '').replace(/\.ets\.ts/g, '.ets').trim()}\n`;
          errorMessage = this.filterModuleError(errorMessage)
            .replace(/^ERROR in /, 'ETS:ERROR File: ').replace(/\s{6}TS/g, ' TS')
            .replace(/\(([0-9]+),([0-9]+)\)/, ':$1:$2');
          this.printErrorMessage(errorMessage, false, errors[index]);
        }
      }
    }
  }
  private printErrorMessage(errorMessage: string, lineFeed: boolean, errorInfo: Info): void {
    if (this.validateError(errorMessage)) {
      if (lineFeed) {
        logger.error(this.red, errorMessage + '\n', this.reset);
      } else {
        logger.error(this.red, errorMessage, this.reset);
      }
    } else {
      const errorsIndex = this.mStats.compilation.errors.indexOf(errorInfo);
      this.mStats.compilation.errors.splice(errorsIndex, 1);
      this.mErrorCount = this.mErrorCount - 1;
    }
  }
  private validateError(message: string): boolean {
    const propInfoReg: RegExp = /Cannot find name\s*'(\$?[_a-zA-Z0-9]+)'/;
    const componentNameReg: RegExp = /'typeof\s*(\$?[_a-zA-Z0-9]+)' is not callable/;
    const stateInfoReg: RegExp = /Property\s*'(\$[_a-zA-Z0-9]+)' does not exist on type/;
    const extendInfoReg: RegExp = /Property\s*'([_a-zA-Z0-9]+)' does not exist on type\s*'([_a-zA-Z0-9]+)'\./;
    if (this.matchMessage(message, props, propInfoReg) ||
      this.matchMessage(message, [...componentCollection.customComponents], componentNameReg) ||
      this.matchMessage(message, props, stateInfoReg) ||
      this.matchMessage(message, EXTEND_ATTRIBUTE, extendInfoReg, true)) {
      return false;
    }
    return true;
  }
  private matchMessage(message: string, nameArr: any, reg: RegExp,
    validateComponent: boolean = false): boolean {
    if (reg.test(message)) {
      const match: string[] = message.match(reg);
      if (validateComponent) {
        if (match[1] && match[2] && nameArr.has(match[2])) {
          const attributeArray: string[] = [...nameArr.get(match[2])].map(item => item.attribute);
          if (attributeArray.includes(match[1])) {
            return true;
          }
        }
      } else {
        if (match[1] && nameArr.includes(match[1])) {
          return true;
        }
      }
    }
    return false;
  }
  private filterModuleError(message: string): string {
    if (/You may need an additional loader/.test(message) && transformLog && transformLog.sourceFile) {
      const fileName: string = transformLog.sourceFile.fileName.replace(/.ts$/, '');
      const errorInfos: string[] = message.split('You may need an additional loader to handle the result of these loaders.');
      if (errorInfos && errorInfos.length > 1 && errorInfos[1]) {
        message = `ERROR in ${fileName}\n The following syntax is incorrect.${errorInfos[1]}`;
      }
    }
    return message;
  }
}
