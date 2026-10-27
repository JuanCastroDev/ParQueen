import { useState, useEffect } from 'react';
import { db } from '../../firebase';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import { chatReadMarkerKey } from '../../utils/chatReadMarker';

const CHAT_READ_EVENT = 'parqueen:chat-read';

export function notifyChatRead() {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new Event(CHAT_READ_EVENT));
}

export function useUnreadMessages(userId: string | undefined) {
    const [unreadMessagesCount, setUnreadMessagesCount] = useState(0);

    useEffect(() => {
        setUnreadMessagesCount(0);
        if (!userId || !db) return;
        const q = query(
            collection(db, "chats"),
            where("participants", "array-contains", userId)
        );
        let active = true;
        let latestDocs: Array<{ id: string; data: () => any }> = [];
        const recompute = () => {
            let count = 0;
            latestDocs.forEach(docSnap => {
                const data = docSnap.data();
                const chatId = docSnap.id;

                let timestampMillis = 0;
                if (data.lastMessageTimestamp) {
                    if (typeof data.lastMessageTimestamp.toMillis === 'function') {
                        timestampMillis = data.lastMessageTimestamp.toMillis();
                    } else if (typeof data.lastMessageTimestamp.toDate === 'function') {
                        timestampMillis = data.lastMessageTimestamp.toDate().getTime();
                    } else {
                        timestampMillis = new Date(data.lastMessageTimestamp).getTime();
                    }
                }

                const lastReadStr = localStorage.getItem(chatReadMarkerKey(userId, chatId));
                const lastReadTime = lastReadStr ? parseInt(lastReadStr, 10) : 0;

                if (timestampMillis > lastReadTime && data.lastSenderId !== userId) {
                    count++;
                }
            });
            setUnreadMessagesCount(count);
        };
        const unsubscribe = onSnapshot(q, (snap) => {
            if (!active) return;
            latestDocs = snap.docs;
            recompute();
        }, (err) => {
            if (!active) return;
            console.warn("Chats snapshot listener error:", err);
        });
        window.addEventListener(CHAT_READ_EVENT, recompute);
        return () => {
            active = false;
            window.removeEventListener(CHAT_READ_EVENT, recompute);
            unsubscribe();
        };
    }, [userId]);

    return unreadMessagesCount;
}
