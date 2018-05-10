import init from "../../src/scripts/init.js";
import addImplementation from "../../src/scripts/add-implementation.js";
import sync from "../../src/scripts/sync.js";
import newVersion from "../../src/scripts/new-version.js";
import createProxy from "../../src/scripts/create-proxy.js";
import upgradeProxy from "../../src/scripts/upgrade-proxy.js";
import { FileSystem as fs } from "zos-lib";
import { cleanup, cleanupfn } from "../helpers/cleanup.js";

const Proxy = artifacts.require('Proxy');
const ImplV1 = artifacts.require('ImplV1');
const ImplV2 = artifacts.require('ImplV2');

const should = require('chai')
      .use(require('chai-as-promised'))
      .use(require('../helpers/assertions'))
      .should();

contract('upgrade-proxy command', function([_, owner]) {

  const from = owner;
  const txParams = { from };
  const appName = "MyApp";
  const v1string = "0.1.0";
  const v2string = "0.2.0";
  const network = "test";
  const packageFileName = "test/tmp/package.zos.json";
  const networkFileName = `test/tmp/package.zos.${network}.json`;

  beforeEach('setup', async function() {
    cleanup(packageFileName)
    cleanup(networkFileName)

    await init({ name: appName, version: v1string, packageFileName });
    await addImplementation({ contractName: "ImplV1", contractAlias: "Impl", packageFileName });
    await addImplementation({ contractName: "AnotherImplV1", contractAlias: "AnotherImpl", packageFileName });
    await sync({ packageFileName, network, txParams });
    
    const networkDataV1 = fs.parseJson(networkFileName);
    this.implV1Address = networkDataV1.contracts["Impl"];
    this.anotherImplV1Address = networkDataV1.contracts["AnotherImpl"];

    await createProxy({ contractAlias: "Impl", packageFileName, network, txParams });
    await createProxy({ contractAlias: "Impl", packageFileName, network, txParams });
    await createProxy({ contractAlias: "AnotherImpl", packageFileName, network, txParams });
  
    await newVersion({ version: v2string, packageFileName, txParams });
    await addImplementation({ contractName: "ImplV2", contractAlias: "Impl", packageFileName });
    await addImplementation({ contractName: "AnotherImplV2", contractAlias: "AnotherImpl", packageFileName });
    await sync({ packageFileName, network, txParams });

    const networkDataV2 = fs.parseJson(networkFileName);
    this.implV2Address = networkDataV2.contracts["Impl"];
    this.anotherImplV2Address = networkDataV2.contracts["AnotherImpl"];
  });

  after(cleanupfn(packageFileName));
  after(cleanupfn(networkFileName));

  const assertProxyInfo = async function(contractAlias, proxyIndex, { version, implementation, address, value }) {
    const data = fs.parseJson(networkFileName);
    const proxyInfo = data.proxies[contractAlias][proxyIndex];
    
    if (address)  {
      proxyInfo.address.should.eq(address);
    } else {
      proxyInfo.address.should.be.nonzeroAddress;
    }

    if (implementation) {
      // NOTE: The following may fail if transparent proxies are implemented
      const proxy = Proxy.at(proxyInfo.address);
      const actualImplementation = await proxy.implementation();
      actualImplementation.should.eq(implementation);
    }

    if (version)  {
      proxyInfo.version.should.eq(version);
    }
    
    if (value) {
      const proxy = ImplV1.at(proxyInfo.address);
      const actualValue = await proxy.value();
      actualValue.toNumber().should.eq(value);
    }

    return proxyInfo;
  }

  it('should upgrade the version of a proxy given its address', async function() {
    // Upgrade single proxy
    const proxyAddress = fs.parseJson(networkFileName).proxies["Impl"][0].address;
    await upgradeProxy({ contractAlias: "Impl", proxyAddress, network, packageFileName, txParams });
    await assertProxyInfo('Impl', 0, { version: v2string, implementation: this.implV2Address, address: proxyAddress });

    // Check other proxies were unmodified
    await assertProxyInfo('Impl', 1, { version: v1string, implementation: this.implV1Address });
    await assertProxyInfo('AnotherImpl', 0, { version: v1string, implementation: this.anotherImplV1Address });
  });

  it('should upgrade the version of all proxies given the contract alias', async function() {
    // Upgrade all "Impl" proxies
    await upgradeProxy({ contractAlias: "Impl", proxyAddress: undefined, network, packageFileName, txParams });
    await assertProxyInfo('Impl', 0, { version: v2string, implementation: this.implV2Address });
    await assertProxyInfo('Impl', 1, { version: v2string, implementation: this.implV2Address });

    // Keep AnotherImpl unmodified
    await assertProxyInfo('AnotherImpl', 0, { version: v1string, implementation: this.anotherImplV1Address });
  });

  it('should upgrade the version of all proxies in the app', async function() {
    await upgradeProxy({ contractAlias: undefined, proxyAddress: undefined, all: true, network, packageFileName, txParams });
    await assertProxyInfo('Impl', 0, { version: v2string, implementation: this.implV2Address });
    await assertProxyInfo('Impl', 1, { version: v2string, implementation: this.implV2Address });
    await assertProxyInfo('AnotherImpl', 0, { version: v2string, implementation: this.anotherImplV2Address });
  });

  it('should require all flag to upgrade all proxies', async function() {
    await upgradeProxy(
      { contractAlias: undefined, proxyAddress: undefined, all: false, network, packageFileName, txParams }
    ).should.be.rejected;
  });

  it('should upgrade the remaining proxies if one was already upgraded', async function() {
    // Upgrade a single proxy
    const proxyAddress = fs.parseJson(networkFileName).proxies["Impl"][0].address;
    await upgradeProxy({ contractAlias: "Impl", proxyAddress, network, packageFileName, txParams });
    await assertProxyInfo('Impl', 0, { version: v2string, implementation: this.implV2Address, address: proxyAddress });

    // Upgrade all
    await upgradeProxy({ contractAlias: undefined, proxyAddress: undefined, all: true, network, packageFileName, txParams });
    await assertProxyInfo('Impl', 1, { version: v2string, implementation: this.implV2Address });
    await assertProxyInfo('AnotherImpl', 0, { version: v2string, implementation: this.anotherImplV2Address });
  });

  it('should upgrade a single proxy and migrate it', async function() {
    const proxyAddress = fs.parseJson(networkFileName).proxies["Impl"][0].address;
    await upgradeProxy({ contractAlias: "Impl", initMethod: "migrate", initArgs: [42], proxyAddress, network, packageFileName, txParams });
    await assertProxyInfo('Impl', 0, { version: v2string, implementation: this.implV2Address, address: proxyAddress, value: 42 });
  });

  it('should upgrade multiple proxies and migrate them', async function() {
    await upgradeProxy({ contractAlias: "Impl", initMethod: "migrate", initArgs: [42], proxyAddress: undefined, network, packageFileName, txParams });
    await assertProxyInfo('Impl', 0, { version: v2string, implementation: this.implV2Address, value: 42 });
    await assertProxyInfo('Impl', 1, { version: v2string, implementation: this.implV2Address, value: 42 });
  });
});
