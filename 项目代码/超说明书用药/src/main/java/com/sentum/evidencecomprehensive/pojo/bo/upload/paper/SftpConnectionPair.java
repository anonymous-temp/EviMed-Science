package com.sentum.evidencecomprehensive.pojo.bo.upload.paper;

import com.jcraft.jsch.ChannelSftp;
import com.jcraft.jsch.Session;
import lombok.AllArgsConstructor;
import lombok.Data;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Author: <a href="https://gitee.com/yyyyouhfqaq">bcxsg</a>
 * Description:
 * DateTime: 2025/7/29
 */

@Data
@AllArgsConstructor
public class SftpConnectionPair {

    private static final Logger LOG = LoggerFactory.getLogger(SftpConnectionPair.class);

    private ChannelSftp mainSftp;
    private Session mainSession;
    private ChannelSftp algSftp;
    private Session algSession;

    public void close() {
        closeQuietly(mainSftp, mainSession);
        closeQuietly(algSftp, algSession);
    }

    private void closeQuietly(ChannelSftp sftp, Session session) {
        try {
            if (sftp != null) sftp.exit();
            if (session != null) session.disconnect();
        } catch (Exception e) {
            LOG.warn("关闭SFTP连接失败", e);
        }
    }
}
