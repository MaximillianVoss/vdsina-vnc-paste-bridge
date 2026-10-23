"""Local preparation API.  This package never sends keys or executes text."""

from .vnc_paste_bridge import PacketError, make_packet, make_server, validate_packet

__all__ = ["PacketError", "make_packet", "make_server", "validate_packet"]
