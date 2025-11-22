import './globals.css';

export const metadata = {
    title: 'Wallet Balance Tracking',
    description: 'Check historical wallet balances across multiple chains',
};

export default function RootLayout({ children }) {
    return (
        <html lang="en">
            <body>{children}</body>
        </html>
    );
}
