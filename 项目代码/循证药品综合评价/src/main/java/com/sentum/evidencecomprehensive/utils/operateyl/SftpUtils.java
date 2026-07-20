package com.sentum.evidencecomprehensive.utils.operateyl;

import cn.hutool.core.collection.CollUtil;
import cn.hutool.core.util.StrUtil;
import com.jcraft.jsch.*;
import com.sentum.evidencecomprehensive.constants.Constants;
import lombok.extern.slf4j.Slf4j;

import java.io.File;
import java.io.IOException;
import java.util.List;
import java.util.Vector;

/**
 * Description: 文件操作工具类
 */
@Slf4j
public class SftpUtils {
    
    /**
     * 删除指定remoteDirPath 目录下的所有文件 及其remoteDirPath目录
     * @param sftp  sftp 
     * @param remoteDirPath  要删除的目录
     */
    public static void deleteDirectoryRecursively(ChannelSftp sftp, String remoteDirPath) throws IOException {
        try {
            // 获取指定目录下的所有条目（包括文件和子目录）
            Vector<ChannelSftp.LsEntry> entries = sftp.ls(remoteDirPath);
            for (ChannelSftp.LsEntry entry : entries) {
                if (entry.getFilename().equals(".") || entry.getFilename().equals("..")) continue;
                // 构造完整的文件或子目录路径
                String fullRemotePath = remoteDirPath + Constants.PAD_LEFT_SLASH + entry.getFilename();
                if (entry.getAttrs().isDir()) {
                    // 如果是子目录，则递归删除
                    // deleteDirectoryRecursively(sftp, fullRemotePath);
                    log.info("目前只删除文件");
                } else {
                    // 如果是文件，则直接删除
                    sftp.rm(fullRemotePath);
                }
            }
            // 当子文件和子目录都被删除后，删除当前空目录
            sftp.rmdir(remoteDirPath);
        } catch (SftpException e) {
            throw new IOException("Failed to remove directory or its contents: " + remoteDirPath, e);
        }
    }


    /**
     * 判断当前目录是否存在
     */
    public static boolean directoryExists(ChannelSftp sftp, String remoteDirPath) {
        if (StrUtil.isNotBlank(remoteDirPath)) {
            try {
                // 尝试获取目录下所有条目（包括子目录和文件）
                sftp.ls(remoteDirPath);
                // 如果没有抛出异常，则目录存在
                return true;
            } catch (SftpException e) {
                // 如果异常码是"找不到文件"（通常为2），则说明目录不存在
                if (e.id == ChannelSftp.SSH_FX_NO_SUCH_FILE) {
                    return false;
                }
                // 其他异常情况，可以捕获并处理或重新抛出
                log.error(e.getMessage(), e);
                return false;
            }
        }
        return false;
    }

    public static void mkdirDirs(String remotePath, ChannelSftp channelSftp) throws SftpException {
        List<String> dirs = StrUtil.split(remotePath, Constants.PAD_LEFT_SLASH);
        if (CollUtil.isNotEmpty(dirs)) {
            StringBuffer path = new StringBuffer();
            for (int i = 0; i < dirs.size(); i++) {
                if (StrUtil.isNotBlank(dirs.get(i))) {
                    if (!dirs.get(i).contains(Constants.PAD_DOT)) {
                        path.append(Constants.PAD_LEFT_SLASH).append(dirs.get(i));
                        try {
                            channelSftp.stat(String.valueOf(path));
                        } catch (SftpException e) {
                            channelSftp.mkdir(String.valueOf(path));
                            log.info("该路径不存在{}，已创建完毕", path);
                        } 
                    }
                }
            }
        }
    }
}
