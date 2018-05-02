import Logger from '../utils/Logger'
import Distribution from '../models/Distribution'
import KernelProvider from "../zos-lib/kernel/KernelProvider"
import ContractsProvider from '../models/ContractsProvider'
import PackageFilesInterface from '../utils/PackageFilesInterface'

const log = new Logger('deploy')

// TODO: remove version param
async function deploy(version, { network, from, packageFileName }) {
  const files = new PackageFilesInterface(packageFileName)
  const distribution = new Distribution(from, network)
  if (! files.exists()) throw `Could not find package file ${packageFileName}`

  const zosPackage = files.read()
  let zosNetworkFile

  // 1. Get or create distribution
  if (files.existsNetworkFile(network)) {
    log.info('Reading network file...')
    zosNetworkFile = files.readNetworkFile(network)
    await distribution.connect(zosNetworkFile.distribution.address)
  } else {
    log.info('Network file not found, deploying new distribution...')
    await distribution.deploy()
    createNetworkFile(network, distribution.address(), packageFileName)
    zosNetworkFile = files.readNetworkFile(network)
  }

  // 2. Create new release
  log.info(`Creating release version ${version}...`)
  const release = await distribution.newVersion(version)

  // 3. For each implementation, deploy it and register it into the release
  for (let contractAlias in zosPackage.contracts) {
    // TODO: store the implementation's hash to avoid unnecessary deployments
    log.info(`Deploying ${contractAlias} contract...`)
    const contractName = zosPackage.contracts[contractAlias];
    const contractClass = ContractsProvider.getFromArtifacts(contractName)
    const contractInstance = await distribution.setImplementation(version, contractClass, contractAlias)
    zosNetworkFile.contracts[contractAlias] = contractInstance.address
  }

  // 4. Freeze release
  log.info('Freezing release...')
  await distribution.freeze(version)

  // 5. Register release into kernel
  const kernelAddress = zosPackage.kernel.address
  log.info(`Registering release into kernel address ${kernelAddress}`)
  const kernel = await KernelProvider.from(from, kernelAddress)
  await kernel.register(release.address)

  zosNetworkFile.provider = { address: release.address }

  files.writeNetworkFile(network, zosNetworkFile)
}


function createNetworkFile(network, address, packageFileName) {
  const files = new PackageFilesInterface(packageFileName)
  const zosPackage = files.read()

  delete zosPackage['version']
  delete zosPackage['name']

  const zosNetworkFile = {
    distribution: { address },
    ...zosPackage
  }

  files.writeNetworkFile(network, zosNetworkFile)
}

module.exports = deploy
