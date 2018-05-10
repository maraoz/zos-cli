import _ from 'lodash';
import { Logger } from 'zos-lib';
import { FileSystem as fs, AppManagerProvider, AppManagerDeployer } from "zos-lib";
import StdlibProvider from './stdlib/StdlibProvider';
import StdlibDeployer from './stdlib/StdlibDeployer';
import Stdlib from './stdlib/Stdlib';

const log = new Logger('NetworkAppController');

const EMPTY_NETWORK_PACKAGE = {
  app: { },
  proxies: { },
  contracts: { },
};

export default class NetworkAppController {
  constructor(appController, network, txParams, networkFileName) {
    this.appController = appController;
    this.txParams = txParams;
    this.network = network;
    this.networkFileName = networkFileName || appController.packageFileName.replace(/\.zos\.json\s*$/, `.zos.${network}.json`);
    if (this.networkFileName == appController.packageFileName) {
      throw new Error(`Cannot create network file name from ${appController.packageFileName}`);
    }
  }

  async sync() {
    await this.initApp()
    await this.syncVersion()
    await this.fetchProvider()
    await this.uploadContracts()
    await this.setStdlib()
  }

  async deployStdlib() {
    if (!this.appController.hasStdlib()) {
      delete this.networkPackage['stdlib'];
      return;
    }

    const stdlibAddress = await StdlibDeployer.call(this.package.stdlib.name, this.txParams);
    this.networkPackage.stdlib = { address: stdlibAddress, customDeploy: true, ... this.package.stdlib };
  }

  async createProxy(contractAlias, initMethod, initArgs) {
    if (contractAlias === undefined) throw new Error('Missing required argument contractAlias for createProxy')

    await this.loadApp();
    const contractClass = this.appController.getContractClass(contractAlias);
    const proxyInstance = await this.appManagerWrapper.createProxy(contractClass, contractAlias, initMethod, initArgs);
    
    const proxyInfo = {
      address: proxyInstance.address,
      version: this.appManagerWrapper.version
    };

    const proxies = this.networkPackage.proxies;
    if (!proxies[contractAlias]) proxies[contractAlias] = [];
    proxies[contractAlias].push(proxyInfo);
  }

  async upgradeProxies(contractAlias, proxyAddress, initMethod, initArgs) {
    const proxyInfos = this.getProxies(contractAlias, proxyAddress);
    if (_.isEmpty(proxyInfos)) {
      log.info("No proxies to upgrade were found");
      return;
    }

    await this.loadApp();
    const newVersion = this.appManagerWrapper.version;
    
    await Promise.all(_.flatMap(proxyInfos, (contractProxyInfos, contractAlias) => {
      const contractClass = this.appController.getContractClass(contractAlias);
      return _.map(contractProxyInfos, async (proxyInfo) => {        
        await this.appManagerWrapper.upgradeProxy(proxyInfo.address, contractClass, contractAlias, initMethod, initArgs);
        proxyInfo.version = newVersion;
      });
    }));

    return proxyInfos;
  }

  /**
   * Returns all proxies, optionally filtered by a contract alias and a proxy address
   * @param {*} contractAlias 
   * @param {*} proxyAddress 
   * @returns an object with contract aliases as keys, and arrays of Proxy (address, version) as values
   */
  getProxies(contractAlias, proxyAddress) {
    if (!contractAlias) {
      if (proxyAddress) throw new Error("Must set contract alias if filtering by proxy address");
      return this.networkPackage.proxies;
    }

    return { 
      [contractAlias]: _.filter(this.networkPackage.proxies[contractAlias], proxy => (
        !proxyAddress || proxy.address == proxyAddress
      ))
    };
  }

  /**
   * Returns a single proxy object for the specified contract alias and optional proxy address
   * @param {*} contractAlias 
   * @param {*} proxyAddress address of the proxy, can be omitted if there is a single proxy for this contract
   * @returns a Proxy object (address, version)
   */
  findProxy(contractAlias, proxyAddress) { 
    const proxies = this.networkPackage.proxies; 
    if (_.isEmpty(proxies[contractAlias])) return null; 
    if (proxies[contractAlias].length > 1 && proxyAddress === undefined) throw new Error(`Must provide a proxy address for contracts that have more than one proxy`) 
     
    const proxyInfo = proxies[contractAlias].length === 1 
      ? proxies[contractAlias][0] 
      : _.find(proxies[contractAlias], proxy => proxy.address == proxyAddress); 
 
    return proxyInfo; 
  }

  get package() {
    return this.appController.package;
  }

  get networkPackage() {
    if (!this._networkPackage) {
      this._networkPackage = fs.parseJsonIfExists(this.networkFileName) || _.cloneDeep(EMPTY_NETWORK_PACKAGE);
    }
    return this._networkPackage;
  }

  writeNetworkPackage() {
    fs.writeJson(this.networkFileName, this.networkPackage);
    log.info(`Successfully written ${this.networkFileName}`)
  }

  async initApp() {
    const address = this.networkPackage.app && this.networkPackage.app.address;
    this.appManagerWrapper = address
      ? await AppManagerProvider.from(address, this.txParams)
      : await AppManagerDeployer.call(this.package.version, this.txParams);
    this.networkPackage.app.address = this.appManagerWrapper.address();
  }

  async loadApp() {
    const address = this.networkPackage.app && this.networkPackage.app.address;
    if (!address) throw new Error("Must deploy app to network");
    this.appManagerWrapper = await AppManagerProvider.from(address, this.txParams);
  }

  async syncVersion() {
    // TODO: Why is version on root level in package but within app in network?
    const requestedVersion = this.package.version;
    const currentVersion = this.appManagerWrapper.version;
    if (requestedVersion !== currentVersion) {
      log.info(`Creating new version ${requestedVersion}`);
      await this.appManagerWrapper.newVersion(requestedVersion);
    }
    this.networkPackage.app.version = requestedVersion;
  }

  async fetchProvider() {
    const currentProvider = this.appManagerWrapper.currentDirectory();
    log.info(`Current provider is at ${currentProvider.address}`);
    this.networkPackage.provider = { address: currentProvider.address };
  }

  async uploadContracts() {
    // TODO: Store the implementation's hash or full source code to avoid unnecessary deployments
    return Promise.all(_.map(this.package.contracts, async (contractName, contractAlias) => {
      const contractClass = ContractsProvider.getFromArtifacts(contractName);
      log.info(`Uploading ${contractName} implementation for ${contractAlias}`);
      const contractInstance = await this.appManagerWrapper.setImplementation(contractClass, contractAlias);
      log.info(`Uploaded ${contractName} at ${contractInstance.address}`);
      this.networkPackage.contracts[contractAlias] = contractInstance.address;
    }));
  }

  async setStdlib() {
    if (!this.appController.hasStdlib()) {
      await this.appManagerWrapper.setStdlib();
      delete this.networkPackage['stdlib'];
      return;
    }

    const networkStdlib = this.networkPackage.stdlib;
    const hasNetworkStdlib = !_.isEmpty(networkStdlib);
    const hasCustomDeploy = hasNetworkStdlib && networkStdlib.customDeploy;
    const customDeployMatches = hasCustomDeploy && networkStdlib.name === this.package.stdlib.name;

    if (customDeployMatches) {
      log.info(`Using existing custom deployment of stdlib at ${networkStdlib.address}`);
      await this.appManagerWrapper.setStdlib(networkStdlib.address);
      return;
    }

    // TODO: Check that package version matches the requested one
    log.info(`Connecting to public deployment of ${this.package.stdlib.name} in ${this.network}`);
    const stdlibAddress = StdlibProvider.from(this.package.stdlib.name, this.network);
    await this.appManagerWrapper.setStdlib(stdlibAddress);
    this.networkPackage.stdlib = { address: stdlibAddress, ... this.package.stdlib };
  }
}