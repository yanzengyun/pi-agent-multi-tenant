import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from runner import Pool

ALICE = '11111111-1111-4111-8111-111111111111'
BOB = '22222222-2222-4222-8222-222222222222'

class Tests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        for i in range(2): (self.root/str(i)/'work').mkdir(parents=True)
        self.mount = patch('runner.os.path.ismount', return_value=True); self.mount.start()
        self.addCleanup(self.temporary.cleanup); self.addCleanup(self.mount.stop)

    def test_persistence_is_bound_to_user_and_survives_restart(self):
        pool = Pool(self.root,2)
        a,reused = pool.acquire(ALICE); self.assertFalse(reused)
        (a/'note').write_text('FAKE_ALICE')
        b,_ = pool.acquire(BOB); self.assertFalse((b/'note').exists())
        fresh = Pool(self.root,2); again,reused = fresh.acquire(ALICE)
        self.assertTrue(reused); self.assertEqual((again/'note').read_text(),'FAKE_ALICE')
        with self.assertRaisesRegex(RuntimeError,'sandbox_pool_full'):fresh.acquire('33333333-3333-4333-8333-333333333333')

    def test_release_cleans_slot_without_following_symlinks(self):
        pool=Pool(self.root,2); a,_=pool.acquire(ALICE); b,_=pool.acquire(BOB)
        (b/'keep').write_text('FAKE_BOB'); (a/'escape').symlink_to(b,target_is_directory=True)
        (a/'note').write_text('FAKE_ALICE');pool.release(ALICE)
        self.assertEqual((b/'keep').read_text(),'FAKE_BOB')
        new,reused=pool.acquire('33333333-3333-4333-8333-333333333333')
        self.assertFalse(reused); self.assertEqual(list(new.iterdir()),[])

    def test_release_does_not_stat_a_symlink_target_in_an_inaccessible_directory(self):
        pool=Pool(self.root,2); work,_=pool.acquire(ALICE)
        blocked=self.root/'blocked'; blocked.mkdir(); (blocked/'inside').mkdir()
        (work/'escape').symlink_to(blocked/'inside',target_is_directory=True)
        blocked.chmod(0)
        try:
            pool.release(ALICE)
            self.assertEqual(list(work.iterdir()),[])
        finally:blocked.chmod(0o700)

    def test_reusing_workspace_restores_its_entry_permissions(self):
        pool=Pool(self.root,2); work,_=pool.acquire(ALICE); work.chmod(0)
        same,reused=pool.acquire(ALICE)
        self.assertTrue(reused); self.assertEqual(same.stat().st_mode & 0o777,0o700)

    def test_shrinking_preserves_owners_and_rejects_out_of_range(self):
        for index in range(2, 8): (self.root/str(index)/'work').mkdir(parents=True)
        pool = Pool(self.root, 8)
        work, _ = pool.acquire(ALICE)
        (work/'keep').write_text('FAKE_ALICE')
        smaller = Pool(self.root, 6)
        self.assertEqual(smaller.acquire(ALICE)[0].joinpath('keep').read_text(), 'FAKE_ALICE')
        (self.root/'owners.json').write_text(json.dumps({ALICE: 6}))
        with self.assertRaisesRegex(RuntimeError, 'invalid_pool_ownership'): Pool(self.root, 6)

    def test_dirty_unowned_slots_and_duplicate_ownership_fail_closed(self):
        (self.root/'0'/'work'/'leftover').write_text('FAKE')
        with self.assertRaisesRegex(RuntimeError,'unowned_pool_slot_not_empty'):Pool(self.root,2).acquire(ALICE)
        (self.root/'owners.json').write_text(json.dumps({ALICE:0,BOB:0}))
        with self.assertRaisesRegex(RuntimeError,'invalid_pool_ownership'):Pool(self.root,2)

if __name__=='__main__':unittest.main()
