@echo off
echo Check paths... > node_path.txt
where node >> node_path.txt 2>&1
where npm >> node_path.txt 2>&1
where git >> node_path.txt 2>&1
echo PATH is %PATH% >> node_path.txt
