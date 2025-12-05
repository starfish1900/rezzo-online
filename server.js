const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// --- GAME CONSTANTS ---
const RED = 1;
const BLUE = 2;
const EMPTY = 0;
const SPECTATOR = 0; // New Constant

const DIRS_KING = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];
const DIRS_KNIGHT = [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]];

class RezzoGame {
    constructor(size = 13) {
        this.N = size;
        this.board = [];
        this.turn = RED;
        this.turnPhase = 0; 
        this.firstMovePiece = null;
        this.history = new Set();
        this.isRedFirstTurn = true;
        this.gameOver = false;
        this.winner = null;
        this.lastMoveHighlights = [];
        
        this.zobrist = this.initZobrist(size);
        this.initBoard();
    }

    initZobrist(size) {
        const table = [];
        for(let r=0; r<size; r++) {
            table[r] = [];
            for(let c=0; c<size; c++) {
                table[r][c] = {
                    [RED]: Math.floor(Math.random() * 2147483647),
                    [BLUE]: Math.floor(Math.random() * 2147483647)
                };
            }
        }
        return {
            table,
            turn: Math.floor(Math.random() * 2147483647)
        };
    }

    initBoard() {
        this.board = Array(this.N).fill(null).map(() => Array(this.N).fill(EMPTY));
        for (let r = 0; r < 2; r++) {
            for (let c = 0; c < this.N; c++) this.board[r][c] = RED;
        }
        for (let r = this.N - 2; r < this.N; r++) {
            for (let c = 0; c < this.N; c++) this.board[r][c] = BLUE;
        }
        this.addToHistory(RED);
    }

    getHash(turnPlayer) {
        let h = 0;
        if (turnPlayer === BLUE) h ^= this.zobrist.turn;
        for (let r = 0; r < this.N; r++) {
            for (let c = 0; c < this.N; c++) {
                const p = this.board[r][c];
                if (p !== EMPTY) h ^= this.zobrist.table[r][c][p];
            }
        }
        return h;
    }

    addToHistory(currentTurn) {
        this.history.add(this.getHash(currentTurn));
    }

    checkSuperKo(tempBoard, predictedTurn) {
        let h = 0;
        if (predictedTurn === BLUE) h ^= this.zobrist.turn;
        for (let r = 0; r < this.N; r++) {
            for (let c = 0; c < this.N; c++) {
                const p = tempBoard[r][c];
                if (p !== EMPTY) h ^= this.zobrist.table[r][c][p];
            }
        }
        return this.history.has(h);
    }

    cloneBoard() {
        return this.board.map(row => [...row]);
    }

    isValidPos(r, c) {
        return r >= 0 && r < this.N && c >= 0 && c < this.N;
    }

    getLegalSingleMoves(r, c) {
        const moves = [];
        const allDirs = [...DIRS_KING, ...DIRS_KNIGHT];
        for (let d of allDirs) {
            const nr = r + d[0];
            const nc = c + d[1];
            if (this.isValidPos(nr, nc) && this.board[nr][nc] === EMPTY) {
                moves.push({r: nr, c: nc});
            }
        }
        return moves;
    }

    getValidTrainDestinations(tailR, tailC) {
        if (this.turn === RED && this.isRedFirstTurn) return [];

        const moves = [];
        const color = this.board[tailR][tailC];
        if (color !== this.turn) return [];

        const scanDirs = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];

        for (let dir of scanDirs) {
            const [dr, dc] = dir;
            let trainPieces = [{r: tailR, c: tailC}];
            let currR = tailR + dr;
            let currC = tailC + dc;

            while (this.isValidPos(currR, currC) && this.board[currR][currC] === color) {
                trainPieces.push({r: currR, c: currC});
                currR += dr;
                currC += dc;
            }

            const head = trainPieces[trainPieces.length - 1];
            const length = trainPieces.length;
            if (length < 2) continue; 

            let dist = 1;
            let moveR = head.r + dr;
            let moveC = head.c + dc;

            while (dist <= length && this.isValidPos(moveR, moveC)) {
                const targetContent = this.board[moveR][moveC];
                let isCapture = false;
                let stop = false;
                let captureInfo = null;

                if (targetContent === color) {
                    stop = true;
                } else if (targetContent === EMPTY) {
                    // Continue
                } else {
                    const enemyResult = this.analyzeEnemyAlignment(moveR, moveC, dr, dc, targetContent);
                    if (enemyResult.type === 'isolated' || enemyResult.type === 'diff_orientation') {
                        isCapture = true; 
                        stop = true; 
                        captureInfo = enemyResult;
                    } else if (enemyResult.type === 'same_orientation') {
                        if (enemyResult.length < length) {
                            isCapture = true;
                            stop = true;
                            captureInfo = enemyResult;
                        } else {
                            stop = true;
                        }
                    }
                }

                if (!stop || isCapture) {
                    moves.push({
                        type: 'train',
                        tail: {r: tailR, c: tailC},
                        head: {r: head.r, c: head.c},
                        dest: {r: moveR, c: moveC},
                        dir: {dr, dc},
                        length: length,
                        capture: isCapture,
                        captureInfo: captureInfo
                    });
                }

                if (stop) break;
                moveR += dr;
                moveC += dc;
                dist++;
            }
        }
        return moves;
    }

    analyzeEnemyAlignment(r, c, dr, dc, enemyColor) {
        let axisCount = 1; 
        let tr = r + dr; let tc = c + dc;
        while (this.isValidPos(tr, tc) && this.board[tr][tc] === enemyColor) { axisCount++; tr+=dr; tc+=dc; }
        tr = r - dr; tc = c - dc;
        while (this.isValidPos(tr, tc) && this.board[tr][tc] === enemyColor) { axisCount++; tr-=dr; tc-=dc; }

        if (axisCount > 1) {
            return { type: 'same_orientation', length: axisCount };
        }

        const otherDirs = [[1, 0], [0, 1], [1, 1], [1, -1]];
        for (let od of otherDirs) {
            if ( (od[0] === dr && od[1] === dc) || (od[0] === -dr && od[1] === -dc) ) continue;
            let count = 1;
            let f = 1;
            while(this.isValidPos(r + od[0]*f, c + od[1]*f) && this.board[r + od[0]*f][c + od[1]*f] === enemyColor) { count++; f++; }
            f = 1;
            while(this.isValidPos(r - od[0]*f, c - od[1]*f) && this.board[r - od[0]*f][c - od[1]*f] === enemyColor) { count++; f++; }
            if (count > 1) return { type: 'diff_orientation' };
        }
        return { type: 'isolated' };
    }

    canMakeSecondMove(justMovedCurrentPos, forbid_goal_row=null) {
        const pieces = []; // FIXED: Added 'const' declaration
        for(let r=0; r<this.N; r++) {
            for(let c=0; c<this.N; c++) {
                if(this.board[r][c] === this.turn) pieces.push({r,c});
            }
        }
        
        for (let p of pieces) {
            if (p.r === justMovedCurrentPos.r && p.c === justMovedCurrentPos.c) continue;
            
            const dests = this.getLegalSingleMoves(p.r, p.c);
            
            if (forbid_goal_row !== null) {
                // If we find ANY move not on goal row, true
                if (dests.some(d => d.r !== forbid_goal_row)) return true;
            } else {
                if (dests.length > 0) return true;
            }
        }
        return false;
    }

    checkWinCondition(player) {
        const targetRow = player === RED ? this.N - 1 : 0;
        for (let c = 0; c < this.N; c++) {
            if (this.board[targetRow][c] === player) return true;
        }
        return false;
    }

    checkImmediateWin(player) {
        const targetRow = player === RED ? this.N - 1 : 0;
        let piecesOnGoal = [];
        for (let c = 0; c < this.N; c++) {
            if (this.board[targetRow][c] === player) piecesOnGoal.push({r:targetRow, c:c});
        }
        if (piecesOnGoal.length === 0) return false;

        const opponent = this.turn;
        for(let r=0; r<this.N; r++){
            for(let c=0; c<this.N; c++){
                if (this.board[r][c] === opponent) {
                    const trains = this.getValidTrainDestinations(r, c);
                    for(let m of trains) {
                        if(m.capture) {
                            for(let p of piecesOnGoal) {
                                if(m.dest.r === p.r && m.dest.c === p.c) return false;
                            }
                        }
                    }
                }
            }
        }
        return true; 
    }

    endTurn() {
        this.turnPhase = 0;
        this.firstMovePiece = null;
        const prevTurn = this.turn;
        this.turn = this.turn === RED ? BLUE : RED;

        if (this.checkWinCondition(this.turn)) {
            this.gameOver = true;
            this.winner = this.turn;
        }
        if (!this.gameOver) {
            if(this.checkImmediateWin(prevTurn)) {
                this.gameOver = true;
                this.winner = prevTurn;
            }
        }
    }

    processIntent(from, to) {
        const singles = this.getLegalSingleMoves(from.r, from.c);
        const singleMatch = singles.find(m => m.r === to.r && m.c === to.c);
        
        if (singleMatch) {
            if (this.turnPhase === 1) {
                if (this.firstMovePiece && this.firstMovePiece.r === from.r && this.firstMovePiece.c === from.c) {
                    return { success: false, reason: "Must move a different piece" };
                }
            }
            return this.executeMove({ type: 'single', from: from, to: to });
        }

        if (this.turnPhase !== 0) return { success: false, reason: "Invalid Single Move (Train not allowed in phase 2)" };

        const trains = this.getValidTrainDestinations(from.r, from.c);
        const trainMatch = trains.find(m => m.dest.r === to.r && m.dest.c === to.c);

        if (trainMatch) {
            return this.executeMove(trainMatch);
        }

        return { success: false, reason: "Invalid Move" };
    }

    executeMove(move) {
        const backupBoard = this.cloneBoard();
        
        // 1. Apply Logic
        if (move.type === 'single') {
            this.board[move.to.r][move.to.c] = this.board[move.from.r][move.from.c];
            this.board[move.from.r][move.from.c] = EMPTY;
        } else {
            const {tail, head, dest, dir, length, captureInfo} = move;
            const pieceColor = this.board[tail.r][tail.c];
            const enemyColor = pieceColor === RED ? BLUE : RED;
            
            if (move.capture) {
                 if (this.board[dest.r][dest.c] === enemyColor) {
                    const analysis = captureInfo || this.analyzeEnemyAlignment(dest.r, dest.c, dir.dr, dir.dc, enemyColor);
                    this.board[dest.r][dest.c] = EMPTY;
                    if (analysis.type === 'same_orientation') {
                        let tr = dest.r + dir.dr;
                        let tc = dest.c + dir.dc;
                        while(this.isValidPos(tr, tc) && this.board[tr][tc] === enemyColor) {
                            this.board[tr][tc] = EMPTY;
                            tr += dir.dr;
                            tc += dir.dc;
                        }
                    }
                }
            }
            const shiftR = dest.r - head.r;
            const shiftC = dest.c - head.c;
            let cr = tail.r, cc = tail.c;
            let trainCoords = [];
            for(let i=0; i<length; i++) {
                trainCoords.push({r: cr, c: cc});
                cr += dir.dr;
                cc += dir.dc;
            }
            for(let p of trainCoords) this.board[p.r][p.c] = EMPTY;
            for(let p of trainCoords) this.board[p.r + shiftR][p.c + shiftC] = pieceColor;
        }

        // 2. Turn Logic
        let willSwapTurn = false;
        let nextTurn = this.turn;
        const winningRow = (this.turn === RED) ? this.N - 1 : 0;

        if (move.type === 'train') {
            willSwapTurn = true;
            nextTurn = (this.turn === RED) ? BLUE : RED;
        } else {
            const landedOnGoal = (move.to.r === winningRow);

            if (this.turnPhase === 0) {
                if (this.isRedFirstTurn && this.turn === RED) {
                    willSwapTurn = true;
                    nextTurn = BLUE;
                } else {
                    const forbid = landedOnGoal ? winningRow : null;
                    if (!this.canMakeSecondMove(move.to, forbid)) {
                        willSwapTurn = true;
                        nextTurn = (this.turn === RED) ? BLUE : RED;
                    } else {
                        willSwapTurn = false;
                        nextTurn = this.turn;
                    }
                }
            } else {
                // Phase 1
                const firstOnGoal = (this.firstMovePiece.r === winningRow);
                if (firstOnGoal && landedOnGoal) { 
                    this.board = backupBoard; 
                    return { success: false, reason: "Cannot move two pieces to the last row in one turn" }; 
                }
                
                willSwapTurn = true;
                nextTurn = (this.turn === RED) ? BLUE : RED;
            }
        }

        // 3. Super Ko Validation
        if (this.checkSuperKo(this.board, nextTurn)) {
            this.board = backupBoard;
            return { success: false, reason: "Super Ko" };
        }
        
        this.addToHistory(nextTurn);
        
        if (move.type === 'single') {
            if (willSwapTurn) {
                this.endTurn();
                if (this.isRedFirstTurn) this.isRedFirstTurn = false;
            } else {
                this.turnPhase = 1;
                this.firstMovePiece = move.to;
            }
        } else {
            this.endTurn();
            if (this.isRedFirstTurn) this.isRedFirstTurn = false;
        }

        const highlights = [];
        if(move.type === 'single') { highlights.push(move.from); highlights.push(move.to); }
        else { highlights.push(move.tail); highlights.push(move.dest); }

        return { success: true, highlights };
    }
}

const games = new Map();

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    socket.on('create_game', ({ size, playerId }) => {
        if (!playerId) { socket.emit('error', 'No Player ID'); return; }
        
        const gameId = Math.random().toString(36).substring(2, 8).toUpperCase();
        const s = parseInt(size) || 13;
        const game = new RezzoGame(s);
        
        games.set(gameId, {
            game: game,
            players: { [playerId]: RED }, 
            sockets: { [playerId]: socket.id }
        });
        
        socket.join(gameId);
        socket.emit('game_created', { 
            gameId, 
            color: RED, 
            size: s, 
            board: game.board 
        });
        console.log(`Game ${gameId} created by ${socket.id}`);
    });

    socket.on('join_game', ({ gameId, playerId }) => {
        const session = games.get(gameId);
        if (!session) { socket.emit('error', 'Game not found'); return; }
        
        socket.join(gameId); // Ensure socket is in room for broadcasts

        // 1. Rejoining Player
        if (session.players[playerId]) {
            session.sockets[playerId] = socket.id;
            socket.emit('joined_game', { 
                color: session.players[playerId], 
                size: session.game.N,
                board: session.game.board
            });
            // Update state
            socket.emit('board_update', {
                board: session.game.board,
                turn: session.game.turn,
                turnPhase: session.game.turnPhase,
                highlights: session.game.lastMoveHighlights,
                gameOver: session.game.gameOver,
                winner: session.game.winner
            });
            return;
        }

        // 2. New Player
        if (Object.keys(session.players).length < 2) {
            session.players[playerId] = BLUE;
            session.sockets[playerId] = socket.id;
            
            io.to(gameId).emit('game_start', { 
                board: session.game.board,
                turn: session.game.turn,
                highlights: []
            });
            
            socket.emit('joined_game', { 
                color: BLUE, 
                size: session.game.N,
                board: session.game.board
            });
        } 
        // 3. Spectator (New Logic)
        else {
            socket.emit('joined_game', { 
                color: SPECTATOR, // 0
                size: session.game.N,
                board: session.game.board
            });
            // Immediately send current state details
            socket.emit('board_update', {
                board: session.game.board,
                turn: session.game.turn,
                turnPhase: session.game.turnPhase,
                highlights: session.game.lastMoveHighlights,
                gameOver: session.game.gameOver,
                winner: session.game.winner
            });
        }
    });

    socket.on('submit_move', ({ gameId, from, to, playerId }) => {
        const session = games.get(gameId);
        if (!session) return;

        const playerColor = session.players[playerId];
        // Spectators (undefined color or 0) cannot move
        if (!playerColor || playerColor === SPECTATOR) {
            socket.emit('error', 'Spectators cannot play');
            return;
        }

        const game = session.game;

        if (game.gameOver) return;
        if (game.turn !== playerColor) {
            socket.emit('error', 'Not your turn');
            return;
        }

        const result = game.processIntent(from, to);
        
        if (result.success) {
            io.to(gameId).emit('board_update', {
                board: game.board,
                turn: game.turn,
                turnPhase: game.turnPhase,
                highlights: result.highlights,
                gameOver: game.gameOver,
                winner: game.winner
            });
        } else {
            socket.emit('error', result.reason);
        }
    });
    
    socket.on('disconnect', () => {
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
