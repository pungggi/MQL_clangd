const assert = require('assert');

const { createSerialQueue } = require('../src/createProperties');

suite('createSerialQueue', () => {
    test('runs tasks strictly in submission order', async () => {
        const enqueue = createSerialQueue();
        const order = [];

        const runs = [
            enqueue(async () => {
                await new Promise(r => setTimeout(r, 30));
                order.push('slow-first');
            }),
            enqueue(async () => {
                order.push('second');
            }),
            enqueue(async () => {
                order.push('third');
            }),
        ];

        await Promise.all(runs);
        assert.deepStrictEqual(order, ['slow-first', 'second', 'third']);
    });

    test('resolves each call with its own task result', async () => {
        const enqueue = createSerialQueue();
        const [a, b] = [enqueue(async () => 1), enqueue(async () => 2)];
        assert.strictEqual(await a, 1);
        assert.strictEqual(await b, 2);
    });

    test('keeps the queue alive after a rejected task', async () => {
        const enqueue = createSerialQueue();
        const order = [];

        const failing = enqueue(async () => {
            order.push('failing');
            throw new Error('boom');
        });
        const following = enqueue(async () => {
            order.push('following');
            return 'ok';
        });

        await assert.rejects(failing, /boom/);
        assert.strictEqual(await following, 'ok');
        assert.deepStrictEqual(order, ['failing', 'following']);
    });

    test('lets a later task start while an earlier one is still pending', async () => {
        const enqueue = createSerialQueue();
        let releaseFirst;
        const first = enqueue(() => new Promise(resolve => { releaseFirst = resolve; }));

        let secondStarted = false;
        const second = enqueue(async () => { secondStarted = true; });

        await new Promise(r => setTimeout(r, 10));
        assert.strictEqual(secondStarted, false, 'second task must wait for the first');

        releaseFirst();
        await Promise.all([first, second]);
        assert.strictEqual(secondStarted, true);
    });
});
