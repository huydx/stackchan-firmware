#include "playback_pool.h"
#include <cassert>
#include <cstring>
#include <thread>

int main(int argc, char **argv) {
    assert(argc == 2);
    PlaybackPool pool;
    auto *a = pool.freeBlock();
    a->pcm[0] = 1234;
    assert(pool.submit(a));
    auto *b = pool.freeBlock();
    assert(a != b);
    b->pcm[0] = -2345;
    assert(pool.submit(b));
    auto *c = pool.freeBlock();
    assert(c != a && c != b);
    assert(pool.submit(c));
    assert(!pool.freeBlock());
    if (!std::strcmp(argv[1], "borrow")) {
        // Completing another request must not free the memory still being read.
        std::thread worker([&] {
            assert(a->pcm[0] == 1234 && b->pcm[0] == -2345);
            pool.release(a->pcm);
        });
        worker.join();
        assert(pool.releasedFront() == a);
        assert(!pool.freeBlock()); // release must also be consumed by the owner
        pool.popReleased();
        assert(pool.freeBlock() == a && b->pcm[0] == -2345);
        assert(!pool.releasedFront());
    } else if (!std::strcmp(argv[1], "order")) {
        // Callback notices can arrive between loop iterations. ACK order is FIFO.
        pool.release(b->pcm);
        assert(!pool.releasedFront());
        pool.release(a->pcm);
        assert(pool.releasedFront() == a);
        pool.popReleased();
        assert(pool.releasedFront() == b);
        pool.popReleased();
        assert(pool.pending() == 1);
        pool.release(c->pcm);
        pool.popReleased();
        assert(pool.pending() == 0);
    } else {
        pool.reset();
        for (int i = 0; i < 1000; ++i) {
            auto *block = pool.freeBlock();
            block->pcm[0] = i;
            assert(pool.submit(block));
            assert(!pool.submit(block));
            pool.release(block->pcm);
            assert(pool.releasedFront()->pcm[0] == i);
            pool.popReleased();
            assert(!pool.pending());
        }
    }
}
