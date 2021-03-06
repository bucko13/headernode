'use strict';
const assert = require('bsert');

const { Network, ChainEntry } = require('bcoin');

const HeaderNode = require('../lib/headernode');
const { rimraf, sleep } = require('./util/common');
const {
  initFullNode,
  initNodeClient,
  initWalletClient,
  initWallet,
  generateInitialBlocks,
  generateBlocks,
  // generateReorg,
} = require('./util/regtest');

const network = Network.get('regtest');

const testPrefix = '/tmp/bcoin-fullnode';
const headerTestPrefix = '/tmp/bcoin-headernode';
const genesisTime = 1534965859;

const ports = {
  full: {
    p2p: 49331,
    node: 49332,
    wallet: 49333,
  },
  header: {
    p2p: 49431,
    node: 49432,
    wallet: 49433,
  },
};

describe('HeaderNode', function() {
  this.timeout(30000);
  let node = null;
  let headerNode = null;
  let fastNode = null;
  let wallet = null;
  let nclient,
    wclient = null;
  let coinbase,
    headerNodeOptions,
    initHeight = null;

  before(async () => {
    await rimraf(testPrefix);
    await rimraf(headerTestPrefix);

    initHeight = 20;

    node = await initFullNode({
      ports,
      prefix: testPrefix,
      logLevel: 'error',
    });

    headerNodeOptions = {
      prefix: headerTestPrefix,
      network: network.type,
      port: ports.header.p2p,
      httpPort: ports.header.node,
      logLevel: 'error',
      nodes: [`127.0.0.1:${ports.full.p2p}`],
      memory: false,
      workers: true,
    };
    headerNode = new HeaderNode(headerNodeOptions);

    nclient = await initNodeClient({ ports: ports.full });
    wclient = await initWalletClient({ ports: ports.full });
    wallet = await initWallet(wclient);

    await wclient.execute('selectwallet', ['test']);
    coinbase = await wclient.execute('getnewaddress', ['blue']);

    await generateInitialBlocks({
      nclient,
      wclient,
      coinbase,
      genesisTime,
      blocks: initHeight,
    });
    await headerNode.ensure();
    await headerNode.open();
    await headerNode.connect();
    await headerNode.startSync();
    await sleep(1000);
  });

  after(async () => {
    await wallet.close();
    await wclient.close();
    await nclient.close();
    await node.close();
    await headerNode.close();
    await rimraf(testPrefix);
    await rimraf(headerTestPrefix);

    // clear checkpoint information on bcoin module
    if (node.network.lastCheckpoint) {
      node.network.checkpointMap = {};
      node.network.lastCheckpoint = 0;
    }

    if (fastNode && fastNode.opened) await fastNode.close();
  });

  it('should create a new HeaderNode', async () => {
    assert(headerNode);
  });

  it('should sync a chain of block headers from peers', async () => {
    for (let i = 0; i < initHeight; i++) {
      // first block doesn't have valid headers
      if (i === 0) continue;

      const entry = await node.chain.getEntry(i);
      const header = await headerNode.getHeader(i);

      if (!header) throw new Error(`No header in the index for block ${i}`);

      assert.equal(entry.hash.toString('hex'), header.hash.toString('hex'));
    }
  });

  it('should index new block headers when new blocks are \
mined on the network', async () => {
    const count = 10;

    // mine some blocks while header node is offline
    await generateBlocks(count, nclient, coinbase);
    await sleep(500);

    const tip = await nclient.execute('getblockcount');

    const headerTip = await headerNode.getTip();
    const header = await headerNode.getHeader(headerTip.height);

    assert.equal(
      tip,
      headerTip.height,
      'Expected chain tip and header tip to be the same'
    );
    assert(header, 'Expected to get a header for the latest tip');
  });

  it('should start syncing from last tip when restarted', async () => {
    let headerTip;
    const count = 10;
    await headerNode.disconnect();

    // mine some blocks while header node is offline
    await generateBlocks(count, nclient, coinbase);
    await sleep(500);

    let tip = await nclient.execute('getblockcount');
    headerTip = await headerNode.getTip();

    assert.equal(
      tip - count,
      headerTip.height,
      'Headers tip before sync should same as before blocks were mined'
    );

    // reset the chain in case in-memory chain not picked up by GC
    await resetChain(headerNode);

    headerTip = await headerNode.getTip();
    const header = await headerNode.getHeader(headerTip.height);

    assert.equal(
      headerTip.height,
      tip,
      'Expected chain tip and header tip to be the same'
    );
    assert(header, 'Expected to get a header for the latest tip after restart');

    // now check subscriptions are still working for new blocks
    await generateBlocks(count, nclient, coinbase);
    await sleep(500);
    tip = await nclient.execute('getblockcount');

    headerTip = await headerNode.getTip();

    assert.equal(
      tip,
      headerTip.height,
      'Expected chain tip and header tip to be the same after new blocks mined'
    );

    assert(
      header,
      'Expected to get a header for the latest tip after blocks mined'
    );
  });

  it('should support checkpoints', async () => {
    // header index needs to maintain chain from the last checkpoint
    // this test will set a checkpoint for our regtest network
    // reset the headernode chain similar to the previous test
    // and then confirm that only the non-historical blocks were
    // restored on the chain

    const checkpoint = await headerNode.getTip();
    const count = 10;

    // mine a block on top of the checkpoint
    await generateBlocks(1, nclient, coinbase);
    await sleep(500);

    await headerNode.disconnect();

    // mine some blocks while header node is offline
    await generateBlocks(count, nclient, coinbase);
    await sleep(500);

    // set checkpoint
    headerNode.network.checkpointMap = { [checkpoint.height]: checkpoint.hash };
    headerNode.network.lastCheckpoint = checkpoint.height;

    // resetting chain db to clear from memory
    await resetChain(headerNode);

    const historicalEntry = await headerNode.chain.getEntryByHeight(
      checkpoint.height - 2
    );

    const checkpointEntry = await headerNode.chain.getEntryByHeight(
      checkpoint.height + 1
    );

    assert(
      !historicalEntry,
      'Expected there to be no entry for height earlier than checkpoint'
    );
    assert(
      checkpointEntry,
      'Expected there to be an entry for height after checkpoint'
    );
  });

  it.only('should support fast sync with custom starting header', async () => {
    // need to reset checkpoints otherwise causes issues for creating a new node
    if (node.network.lastCheckpoint) {
      node.network.checkpointMap = {};
      node.network.lastCheckpoint = 0;
    }

    // arbitrary block to start our new node's chain from
    // creating a tip with two blocks (prev and tip)
    const startHeight = 50;
    const startTip = [];
    let entry = await node.chain.getEntryByHeight(startHeight);
    startTip.push(entry.toRaw('hex'));
    entry = await node.chain.getEntryByHeight(startHeight + 1);
    startTip.push(entry.toRaw('hex'));

    const options = {
      ...headerNodeOptions,
      port: ports.header.p2p + 10,
      httpPort: ports.header.node + 10,
      fastSync: true,
      startTip: startTip,
      memory: true,
      logLevel: 'info',
    };

    // NOTE: since the functionality to start at a later height
    // involves mutating the networks module's lastCheckpoint
    // this will impact all other nodes involved in tests since
    // they all share the same bcoin instance
    fastNode = new HeaderNode(options);
    await fastNode.ensure();
    await fastNode.open();
    await fastNode.connect();
    await fastNode.startSync();
    await sleep(1500);

    const oldHeader = await fastNode.getHeader(startHeight - 1);
    const newHeader = await fastNode.getHeader(startHeight);
    console.log('node tip', fastNode.headerindex.state);
    assert(
      !oldHeader,
      'Did not expect to see an earlier block than the start height'
    );
    assert(
      newHeader,
      'Expected to be able to retrieve a header later than start point'
    );

    // let's just test that it can resync too
    await resetChain(fastNode);
    const tip = await nclient.execute('getblockcount');
    const fastTip = await fastNode.getTip();

    assert.equal(
      tip,
      fastTip.height,
      'Expected chain tip and header tip to be the same after new blocks mined'
    );
  });

  xit('should handle a reorg', () => {});
});

/*
 * Helpers
 */

async function resetChain(node) {
  // reset chain to 0 again
  await node.chain.db.reset(0);
  await node.close();
  await node.open();
  await node.connect();
  await node.startSync();

  // let indexer catch up
  await sleep(500);
}
