import { getDescendantsOfType, flatten, getAnnotation, getClassMetadata, hasMetadata } from "./utils";
import { Annotation, Constructor, Metadata, TestMethod, DEFAULT_ORDER } from "./common";
import { StringBuilder } from "@rbxts/string-builder";

type TestClassInstance = Record<string, Callback>;
type TestClassConstructor = Constructor<TestClassInstance>;

type TestClassType = {
	[Metadata.TestList]: Map<string, TestMethod>;
	setUp?: Callback;
	beforeAll?: Callback;
	beforeEach?: Callback;
	afterAll?: Callback;
	afterEach?: Callback;

	[key: string]: unknown;
};

interface TestCaseResult {
	readonly errorMessage?: string;
	readonly timeElapsed: number;
}


export class TestRunner {
	private readonly testClasses: [TestClassConstructor, TestClassInstance][];
	private results: Map<TestClassConstructor, Map<TestMethod, TestCaseResult>>;

	private failedTests: number;
	private passedTests: number;
	private skippedTests: number;

	public constructor(roots: Instance[], _?: object) {
		this.testClasses = new Array<[TestClassConstructor, TestClassInstance]>();
		this.results = new Map<TestClassConstructor, Map<TestMethod, TestCaseResult>>();
		this.failedTests = 0;
		this.passedTests = 0;
		this.skippedTests = 0;

		const modules = flatten(roots.map((root) => getDescendantsOfType(root, "ModuleScript")));
		for (const module of modules) {
			const testClass = <Constructor>require(module);
			this.addClass(testClass);
		}
	}

	private addClass(ctor: Constructor): void {
		if (ctor === undefined || (ctor as unknown as { new: unknown }).new === undefined) return;

		const testClass = <TestClassConstructor>ctor;
		const newClass = <TestClassInstance>new ctor();

		if (newClass.setUp !== undefined) {
			newClass.setUp(newClass);
		}

		this.testClasses.push([testClass, newClass]);
	}

	public async run(): Promise<void> {
		const start = os.clock();

		const promisesToResolve: Promise<void>[] = [];

		for (const [testClass, testClassInstance] of this.testClasses) {
			// run beforeAll here

			await Promise.try(() => {
				const beforeAllCallbacks = getAnnotation(testClass, Annotation.BeforeAll);
				beforeAllCallbacks.forEach((callback) => callback());
			})
                .catch(() => {})
				.finally(() => {
					const runClass = this.runTestClass(testClass, testClassInstance);

					runClass.forEach((promise) => {
						promisesToResolve.push(promise);
					});
				})
		}

		await Promise.all(promisesToResolve).then(() => {
			const elapsedTime = os.clock() - start;
			print(this.generateOutput(elapsedTime));
		});
	}

	private getTestsFromTestClass(testClass: TestClassConstructor): ReadonlyArray<TestMethod> {
		if (hasMetadata(testClass, Metadata.TestList) === false) return [];

		const list: Map<string, TestMethod> = (testClass as unknown as TestClassType)[Metadata.TestList];

		const res = new Array<TestMethod>();
		list.forEach((val) => {
			// make sure each TestMethod isATest
			if (val.options.isATest === true) {
				res.push(val);
			}
		});

        // Order the tests by the order where the default order is 999
        res.sort((a, b) => {
            return (a.options.order || DEFAULT_ORDER) <= (b.options.order || DEFAULT_ORDER);
        })

		return res;
	}

	private runTestClass(testClass: TestClassConstructor, testClassInstance: TestClassInstance): Promise<void>[] {
		const addResult = (test: TestMethod, result: TestCaseResult) => {
			let classResults = this.results.get(testClass);
			if (classResults === undefined) {
				const newMap = new Map<TestMethod, TestCaseResult>();
				this.results.set(testClass, newMap);
				classResults = newMap;
			}

			classResults.set(test, result);
		};

		const fail = (exception: unknown, test: TestMethod, results: Omit<TestCaseResult, "errorMessage">): void => {
			this.failedTests++;
			addResult(test, {
				errorMessage: tostring(exception),
				timeElapsed: results.timeElapsed,
			});
		};

		const pass = (test: TestMethod, results: Omit<TestCaseResult, "errorMessage">): void => {
			this.passedTests++;
			addResult(test, {
				timeElapsed: results.timeElapsed,
			});
		};

		const skip = (test: TestMethod, results: Omit<TestCaseResult, "errorMessage">): void => {
			this.skippedTests++;
			addResult(test, {
				timeElapsed: results.timeElapsed,
			});
		};

		const runTestCase = async (callback: Callback, test: TestMethod): Promise<void> => {
			const start = os.clock();
			try {
				await callback();
			} catch (e) {
				const timeElapsed = os.clock() - start;
				fail(e, test, { timeElapsed });
				return Promise.resolve();
			}

			const timeElapsed = os.clock() - start;
			pass(test, { timeElapsed });
			return Promise.resolve();
		};

		const testList = this.getTestsFromTestClass(testClass);

		const testPromises = testList.map(async (test) => {

           await Promise.try(() => {
                const beforeEachCallbacks = getAnnotation(testClass, Annotation.BeforeEach);
			    beforeEachCallbacks.forEach((callback) => callback(testClassInstance));

            })
            .catch(() => {});
          

          // skip the test before it can be executed
		    if (test.options.disabled?.value === true) {
			    skip(test, { timeElapsed: 0 });
				return Promise.resolve();
		    }

            if (test.options.scope !== undefined) {
                const testScope = test.options.scope;

                const runService = game.GetService("RunService");
                const isClientScope = runService.IsClient();

                if ((isClientScope === false && testScope === "Client") || (isClientScope === true && testScope === "Server")) {
                    skip(test, { timeElapsed: 0 });
                    return Promise.resolve();
                }
            }

	
			const callback = <Callback>(testClass as unknown as TestClassType)[test.name];
			const res = runTestCase(() => callback(testClassInstance), test);

			const afterEachCallback = getAnnotation(testClass, Annotation.AfterEach);
			afterEachCallback.forEach((cb) => cb(testClassInstance));

			return res;
		});

		const afterAllCallback = getAnnotation(testClass, Annotation.AfterAll);
		afterAllCallback.forEach((callback) => callback(testClassInstance));

		return testPromises;
	}

	private generateOutput(elapsedTime: number): string {
		const results = new StringBuilder("\n\n");

		const getSymbol = (passed: boolean, skipped?: boolean) => (skipped === true ? "-" : passed ? "+" : "x");

		const totalTestsRan = this.failedTests + this.passedTests + this.skippedTests;

		if (totalTestsRan === 0) {
			results.appendLine("No tests ran.");
			return results.toString();
		}

		this.results.forEach((testResultsRecord, testClass) => {
			const testClassMetadata = getClassMetadata(testClass);

			const className = testClassMetadata?.displayName ?? (testClass as unknown as string);

			const testResults: [TestMethod, TestCaseResult][] = [];
			testResultsRecord.forEach((value, key) => {
				testResults.push([key, value]);
			});

			const allTestsPassed = testResults.every(([_, cases]) => cases.errorMessage === undefined);
			const totalTimeElapsed = testResults.map(([_, val]) => val.timeElapsed).reduce((sum, n) => sum + n);

			results.appendLine(
				`[${getSymbol(allTestsPassed)}] ${className} (${math.round(totalTimeElapsed * 1000)}ms)`,
			);

			testResults.forEach((testResult, index) => {
				const [testCaseMetadata, testCase] = testResult;

				// get the testCase metadata properties
				const testDisabledOptions = testCaseMetadata.options.disabled;

				const passed = testCase.errorMessage === undefined;
				const timeElapsed = testCase.timeElapsed;
				const isLast = index === testResults.size() - 1;

				results.append(" │");

				if (testDisabledOptions?.value === true) {
					results.appendLine(
						`\t${isLast ? "└" : "├"}── [${getSymbol(passed, testDisabledOptions.value)}] ${testCaseMetadata.options.displayName ?? testCaseMetadata.name} (SKIPPED: ${testDisabledOptions.message})`,
					);
				} else {
					results.appendLine(
						`\t${isLast ? "└" : "├"}── [${getSymbol(passed)}] ${testCaseMetadata.options.displayName ?? testCaseMetadata.name} (${math.round(timeElapsed * 1000)}ms) ${!passed ? "FAILED" : ""}`,
					);
				}
			});

			results.appendLine("");
		});

		if (this.failedTests > 0) {
			results.appendLine("Failures:");

			let failureIndex = 0;

			for (const [className, testResults] of pairs(this.results))
				for (const [testCaseName, { errorMessage }] of pairs(testResults)) {
					if (errorMessage === undefined) continue;
					results.appendLine(`${++failureIndex}. ${className}.${testCaseName}`);

					const errorDisplay = tostring(errorMessage)
						.split("\n")
						.map((line) => "   " + line)
						.join("\n\t");
					results.appendLine(errorDisplay);
					results.appendLine("");
				}
		}

		const totalTests = this.passedTests + this.failedTests;
		results.appendLine("");
		results.appendLine(`\tRan ${totalTests} tests in ${math.round(elapsedTime * 1000)}ms`);
		results.appendLine(`\t\tPassed: ${this.passedTests}`);
		results.appendLine(`\t\tFailed: ${this.failedTests}`);
		results.appendLine(`\t\tSkipped: ${this.skippedTests}`);
		results.appendLine("");

		return results.toString();
	}
}
