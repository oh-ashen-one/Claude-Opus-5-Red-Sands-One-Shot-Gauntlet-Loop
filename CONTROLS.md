# Kaze no Michi — controls

Click the page once to capture the mouse.

| Input | Action |
|---|---|
| W A S D | move |
| Mouse | look |
| Shift | sprint — and **gallop** when riding |
| **Space** | **jump** |
| C *or* Left Ctrl | dodge / roll |
| Left mouse | light attack |
| Right mouse | heavy attack (release to parry) |
| 1 2 3 4 | stance — Stone, Water, Wind, Moon |
| Q | guiding wind — points to your objective |
| **F** | mount / dismount the horse (walk near it and the prompt appears) |
| E | interact |
| Esc | release the mouse |

**Riding:** press F near the horse, then hold **Shift** to gallop. Without Shift the horse
only trots at 4.6 m/s, which is slower than sprinting on foot.

## Performance

The Studio runs the full tier at ~75fps. A laptop will want a lower one:

    http://localhost:5810/?q=low       # 1x pixel ratio, 30% grass, 1k shadows
    http://localhost:5810/?q=medium    # 1.25x, 60% grass, 2k shadows
    http://localhost:5810/?q=high      # full

Without `?q=` the tier is guessed from CPU core count.

## Jumping around the 60-minute arc

    __GAME.quest.list()      // all ten beats
    __GAME.quest.goto('duel')// jump to a beat by id or index
    __GAME.quest.next()      // advance one
    __GAME.setTime(0.726)    // golden hour is 0.712-0.750; night is 0.02
    __GAME.fps

Arc: shore → wind → village → ride → shrine → camp → ambush → climb → duel → end.
