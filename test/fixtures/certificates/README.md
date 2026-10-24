# Test certificates

Test-only RSA keys and certificates for client certificate authentication. They protect nothing; never use them outside tests.

Each PEM file holds the client certificate followed by the same 2048-bit private key in a different format. `chain.pem` adds the test CA certificate after the client certificate. The encrypted keys use the password `' fixture password '`, including the spaces. `client.pfx` holds the client certificate and key as PKCS#12 with an empty password.

Generated once with OpenSSL 3.5:

```sh
password=' fixture password '
openssl req -x509 -newkey rsa:2048 -noenc -keyout ca-key.pem -out ca.pem -days 36500 \
  -subj '/CN=azurefetch test CA' -addext basicConstraints=critical,CA:TRUE -addext keyUsage=critical,keyCertSign
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out key.pem
openssl req -new -key key.pem -subj '/CN=azurefetch test client' |
  openssl x509 -req -CA ca.pem -CAkey ca-key.pem -days 36500 -out client.pem \
    -extfile <(printf 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\n')
openssl pkey -in key.pem -traditional -out key-pkcs1.pem
openssl pkcs8 -topk8 -in key.pem -v2 aes-256-cbc -v2prf hmacWithSHA256 -passout pass:"$password" -out key-encrypted-pkcs8.pem
openssl pkey -in key.pem -traditional -aes256 -passout pass:"$password" -out key-encrypted-legacy.pem
openssl pkcs12 -export -in client.pem -inkey key.pem -passout pass: -out client.pfx

cat client.pem key.pem > pkcs8.pem
cat client.pem key-pkcs1.pem > pkcs1.pem
cat client.pem key-encrypted-pkcs8.pem > encrypted-pkcs8.pem
cat client.pem key-encrypted-legacy.pem > encrypted-legacy.pem
cat client.pem ca.pem key.pem > chain.pem
```

The CA key and the intermediate files are not kept.
