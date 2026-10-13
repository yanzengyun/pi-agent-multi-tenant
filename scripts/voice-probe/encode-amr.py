"""Encode bounded mono PCM16 to AMR-NB using the system OpenCORE library."""
import ctypes
import ctypes.util
import json
import sys
import warnings


def library():
    path = ctypes.util.find_library('opencore-amrnb')
    if not path:
        raise RuntimeError('amr_encoder_unavailable')
    lib = ctypes.CDLL(path)
    lib.Encoder_Interface_init.argtypes = [ctypes.c_int]
    lib.Encoder_Interface_init.restype = ctypes.c_void_p
    lib.Encoder_Interface_Encode.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.POINTER(ctypes.c_short), ctypes.POINTER(ctypes.c_ubyte), ctypes.c_int]
    lib.Encoder_Interface_Encode.restype = ctypes.c_int
    lib.Encoder_Interface_exit.argtypes = [ctypes.c_void_p]
    return lib


def encode(pcm):
    if not pcm or len(pcm) % 2 or len(pcm) > 16000 * 2 * 60:
        raise ValueError('invalid_pcm')
    with warnings.catch_warnings():
        warnings.simplefilter('ignore', DeprecationWarning)
        import audioop
    resampled = audioop.ratecv(pcm, 2, 1, 16000, 8000, None)[0]
    lib = library()
    state = lib.Encoder_Interface_init(0)
    if not state:
        raise RuntimeError('amr_init_failed')
    output = bytearray(b'#!AMR\n')
    try:
        for offset in range(0, len(resampled), 320):
            frame = resampled[offset:offset + 320].ljust(320, b'\0')
            samples = (ctypes.c_short * 160).from_buffer_copy(frame)
            encoded = (ctypes.c_ubyte * 64)()
            size = lib.Encoder_Interface_Encode(state, 7, samples, encoded, 0)
            if size != 32:
                raise RuntimeError('amr_frame_invalid')
            output.extend(bytes(encoded[:size]))
    finally:
        lib.Encoder_Interface_exit(state)
    return bytes(output)


def self_test():
    import array
    import math
    pcm = array.array('h', [int(10000 * math.sin(2 * math.pi * 440 * i / 16000)) for i in range(16000)]).tobytes()
    amr = encode(pcm)
    assert amr.startswith(b'#!AMR\n') and len(amr) == 6 + 50 * 32
    lib = library()
    lib.Decoder_Interface_init.restype = ctypes.c_void_p
    lib.Decoder_Interface_Decode.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_ubyte), ctypes.POINTER(ctypes.c_short), ctypes.c_int]
    lib.Decoder_Interface_exit.argtypes = [ctypes.c_void_p]
    state = lib.Decoder_Interface_init()
    energy = 0
    try:
        for offset in range(6, len(amr), 32):
            frame = (ctypes.c_ubyte * 32).from_buffer_copy(amr[offset:offset + 32])
            samples = (ctypes.c_short * 160)()
            lib.Decoder_Interface_Decode(state, frame, samples, 0)
            energy += sum(int(value) ** 2 for value in samples)
    finally:
        lib.Decoder_Interface_exit(state)
    assert energy > 0
    for invalid in [b'', b'x', b'\0' * (16000 * 2 * 60 + 2)]:
        try:
            encode(invalid)
        except ValueError:
            continue
        raise AssertionError('invalid input accepted')
    return {'amr_roundtrip': True, 'frames': 50, 'duration_ms': 1000, 'bytes': len(amr)}


if __name__ == '__main__':
    if '--self-test' in sys.argv:
        print(json.dumps(self_test()))
    else:
        sys.stdout.buffer.write(encode(sys.stdin.buffer.read(16000 * 2 * 60 + 2)))
