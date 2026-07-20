package com.sentum.evidencecomprehensive.event.listener;

import cn.hutool.core.io.FileUtil;
import cn.hutool.core.thread.NamedThreadFactory;
import cn.hutool.core.util.StrUtil;
import com.jcraft.jsch.*;
import com.sentum.evidencecomprehensive.constants.Constants;
import com.sentum.evidencecomprehensive.event.AlgAnalysisEvent;
import com.sentum.evidencecomprehensive.event.PictureAnalysisEvent;
import com.sentum.evidencecomprehensive.event.bo.AlgAnalysisBo;
import com.sentum.evidencecomprehensive.event.bo.PictureAnalysisBo;
import com.sentum.evidencecomprehensive.service.handler.GlobalUncaughtExceptionHandler;
import com.sentum.evidencecomprehensive.pojo.bo.mongo.PaperUpload;
import com.sentum.evidencecomprehensive.pojo.bo.upload.paper.PdfAnalysis;
import com.sentum.evidencecomprehensive.utils.CommonUtils;
import com.sentum.evidencecomprehensive.utils.SftpUtils;
import lombok.extern.slf4j.Slf4j;
import org.apache.pdfbox.cos.COSName;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.pdmodel.PDPage;
import org.apache.pdfbox.rendering.PDFRenderer;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.context.event.EventListener;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.query.Criteria;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.stereotype.Component;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.File;
import java.io.FileNotFoundException;
import java.io.IOException;
import java.io.InputStream;
import java.util.Date;
import java.util.Objects;
import java.util.Properties;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

/**
 * @Description:  pdf 转为图片事件监听处理类
 */
@Slf4j
@Component
public class PictureAnalysisListenerEvent {
    private final MongoTemplate mongoTemplate;
    private final ApplicationEventPublisher applicationEventPublisher;

    @Value("${sftp.host}")
    private String sftpHost;
    @Value("${sftp.port}")
    private Integer sftpPort;
    @Value("${sftp.userName}")
    private String sftpUserName;
    @Value("${sftp.password}")
    private String sftpPassword;
    @Value("${sftp.path}")
    private String sftpPath;
    @Value("${sftp.filePath}")
    private String filePath;
    @Value("${localPath.pdf.to.image}")
    private String pdfToImagePath;

    /**
     * session超时时间
     */
    private static final int SESSION_TIMEOUT = 10000;
    /**
     * 管道流超时时间
     */
    private static final int CHANNEL_TIMEOUT = 5000;

    // 设置一个核心数为1 的线程池 来进行解析
    private static final ExecutorService ALG_EXECUTOR = new ThreadPoolExecutor(1, 1,
            0L, TimeUnit.MILLISECONDS,
            new LinkedBlockingQueue<>(100),
            new NamedThreadFactory("alg-analysis", null, false,
                    GlobalUncaughtExceptionHandler.getInstance()));

    public PictureAnalysisListenerEvent(MongoTemplate mongoTemplate, ApplicationEventPublisher applicationEventPublisher) {
        this.mongoTemplate = mongoTemplate;
        this.applicationEventPublisher = applicationEventPublisher;
    }

    // @Async
    @EventListener(classes = PictureAnalysisEvent.class)
    public void pictureAnalysis(PictureAnalysisEvent event) {
        
        Date begin = new Date();
        
        PictureAnalysisBo pictureAnalysisBo = event.getPictureAnalysisBo();
        String paperId = pictureAnalysisBo.getId();
        String questionId = pictureAnalysisBo.getQuestionId();
        Long userId = pictureAnalysisBo.getUserId();
        String type = pictureAnalysisBo.getType();
        String path = pictureAnalysisBo.getPath();
        String studyType = pictureAnalysisBo.getStudyType();
        Boolean algAnalysisSuccess = pictureAnalysisBo.getAlgAnalysisSuccess();
        String pdfFilePath = pictureAnalysisBo.getPdfFilePath();

        PdfAnalysis pdfAnalysis = new PdfAnalysis();
        pdfAnalysis.setPaperId(paperId);
        pdfAnalysis.setUserId(userId);
        pdfAnalysis.setQuestionId(questionId);
        
        PdfAnalysis mongo = mongoTemplate.findOne(
                new Query(Criteria.where("paperId").is(paperId)
                        .and("userId").is(userId)
                        .and("questionId").is(questionId)), PdfAnalysis.class);
        if (Objects.nonNull(mongo)) {
            pdfAnalysis = mongo;
        }
        
        // 上传使用实体类
        PaperUpload paperUpload = mongoTemplate.findOne(
                new Query(Criteria.where("paperId").is(paperId)
                        .and("userId").is(userId)), PaperUpload.class);
        // 默认生成png格式图片
        if (StrUtil.isBlank(type)) {
            type = "png";
        }

        // 在基础目录sftpPath 之下 存放pdf 转图片的基础目录 在基础目录sftpPath + image + images_pdf + path(id)
        String remotePath = CommonUtils.removeSeparatorFromSuffix(sftpPath).concat(Constants.PAD_LEFT_SLASH).concat("image").concat(Constants.PAD_LEFT_SLASH).concat("images_pdf").concat(Constants.PAD_LEFT_SLASH).concat(path);
        String ipRemotePath = CommonUtils.removeSeparatorFromSuffix(filePath).concat(Constants.PAD_LEFT_SLASH).concat("image").concat(Constants.PAD_LEFT_SLASH).concat("images_pdf").concat(Constants.PAD_LEFT_SLASH).concat(path);
        
        // 四角坐标图片存放路径 sftpPath + image + images_alg + path(id)
        String remoteAlgPath = CommonUtils.removeSeparatorFromSuffix(sftpPath).concat(Constants.PAD_LEFT_SLASH).concat("image").concat(Constants.PAD_LEFT_SLASH).concat("images_alg").concat(Constants.PAD_LEFT_SLASH).concat(path);
        String ipAlgRemotePath = CommonUtils.removeSeparatorFromSuffix(filePath).concat(Constants.PAD_LEFT_SLASH).concat("image").concat(Constants.PAD_LEFT_SLASH).concat("images_alg").concat(Constants.PAD_LEFT_SLASH).concat(path);
        
        //  上传成功的操作
        if (Objects.nonNull(paperUpload) && paperUpload.isSuccess()) {
           
            Session jschSession = null;
            try {
                JSch jsch = new JSch();
                jschSession = jsch.getSession(sftpUserName, sftpHost, sftpPort);
                jschSession.setPassword(sftpPassword);
                Properties properties = new Properties();
                properties.put("StrictHostKeyChecking", "no");
                jschSession.setConfig(properties);
                jschSession.connect(SESSION_TIMEOUT);
                Channel sftp = jschSession.openChannel("sftp");
                sftp.connect(CHANNEL_TIMEOUT);
                ChannelSftp channelSftp = (ChannelSftp) sftp;

                // pdf 绝对路径 读取 pdf
                String filePath = paperUpload.getFilePath();
                InputStream inputStream = channelSftp.get(filePath);
                // 在加载 PDF 时设置不严格解析
                PDDocument doc = PDDocument.load(inputStream);
//                try (PDDocument document = PDDocument.load(inputStream)) {
//                    PDPage page = document.getPage(0);
//                    CustomPDFRenderer customPDFRenderer = new CustomPDFRenderer();
//                    customPDFRenderer.render(page);
//                    // 渲染图像
//                    PDFRenderer renderer = new PDFRenderer(document);
//                    int pageCount = document.getNumberOfPages();
//                    for (int i = 0; i < pageCount; i++) {
//                        // dpi为200，越高越清晰，转换越慢
////                        BufferedImage bim = pdfRenderer.renderImageWithDPI(0, 300, ImageType.RGB);
//                        BufferedImage image = renderer.renderImageWithDPI(i, 200);
//                        // 临时图片生成 存放路径
//                        String localPath = CommonUtil.removeSeparatorFromSuffix(pdfToImagePath).concat(Constants.PAD_LEFT_SLASH).concat(paperId + "_" + (i)).concat(Constants.PAD_DOT).concat(type);
//                        File file = new File(localPath);
//                        if (!new File(pdfToImagePath).exists()) {
//                            FileUtil.mkParentDirs(file);
//                        }
//                        ImageIO.write(image, type, file);
//                        if (file.exists()) {
//                            boolean exists = SftpUtils.directoryExists(channelSftp, remotePath);
//                            if (!exists) {
//                                SftpUtils.mkdirDirs(remotePath, channelSftp);
//                            }
//                            String remoteFilePath = CommonUtil.removeSeparatorFromSuffix(remotePath).concat(Constants.PAD_LEFT_SLASH).concat(paperId + "_" + (i)).concat(Constants.PAD_DOT).concat(type);
//                            channelSftp.put(localPath, remoteFilePath);
//
//                            // 解析完图片同时存放另一版本 到alg_images中 需要算法解析 然后渲染四角坐标
//                            boolean algExists = SftpUtils.directoryExists(channelSftp, remoteAlgPath);
//                            if (!algExists) {
//                                SftpUtils.mkdirDirs(remoteAlgPath, channelSftp);
//                            }
//                            String remoteAlgFilePath = CommonUtil.removeSeparatorFromSuffix(remoteAlgPath).concat(Constants.PAD_LEFT_SLASH).concat(paperId + "_" + (i)).concat(Constants.PAD_DOT).concat(type);
//                            channelSftp.put(localPath, remoteAlgFilePath);
//
//                            // 删除本地图片
//                            FileUtil.del(file);
//                            log.info("文献 id{} 的第 {} 张 pdf 转 pic 完成，本地临时图片删除成功。", paperId, i);
//                        }
//                    }
//
//                    pdfAnalysis.setSuccess(true);
//                    pdfAnalysis.setPath(path);
//                    pdfAnalysis.setFilePath(remotePath);
//                    pdfAnalysis.setAlgFilePath(remoteAlgPath);
//                    pdfAnalysis.setIpFilePath(ipRemotePath);
//                    pdfAnalysis.setIpAlgFilePath(ipAlgRemotePath);
//                    pdfAnalysis.setOnePicUrl(CommonUtil.removeSeparatorFromSuffix(ipRemotePath).concat(Constants.PAD_LEFT_SLASH).concat(paperId + "_0." + type));
//                    pdfAnalysis.setType(type);
//                    pdfAnalysis.setImagesCount(pageCount);
//                    mongoTemplate.save(pdfAnalysis);
//                    log.info("文献 id {}, pdf 全部转换图片完成，完成时间{}", paperId, new Date().getTime() - begin.getTime());
//                    
//                    // 保存或处理图像
//                } catch (IOException e) {
//                    log.error("PDF 处理失败: " + e.getMessage());
//                    pdfAnalysis.setSuccess(false);
//                    pdfAnalysis.setAlgSuccess(false);
//                    pdfAnalysis.setStatus(2);
//                    mongoTemplate.save(pdfAnalysis);
//                    log.error("文献 id {}, pdf 转换图片过程中，失败！！！", paperId);
//                    log.error(e.getMessage(), e);
//                } finally {
//                    channelSftp.exit();
//                }

                PDPage page = doc.getPage(0);
                Iterable<COSName> fontNames = doc.getPage(0).getResources().getFontNames();
                for (COSName next : fontNames) {
                    System.out.println("Font: " + next.getName() + ", Type: " + next.getClass());
                }
                inputStream.close();
                
                // 设置字体到渲染器
                PDFRenderer renderer = new PDFRenderer(doc);
                int pageCount = doc.getNumberOfPages();
                try {
                    for (int i = 0; i < pageCount; i++) {
                        // dpi为200，越高越清晰，转换越慢
                        BufferedImage image = renderer.renderImageWithDPI(i, 200);
                        // 临时图片生成 存放路径
                        String localPath = CommonUtils.removeSeparatorFromSuffix(pdfToImagePath).concat(Constants.PAD_LEFT_SLASH).concat(paperId + "_" + (i)).concat(Constants.PAD_DOT).concat(type);
                        File file = new File(localPath);
                        if (!new File(pdfToImagePath).exists()) {
                            FileUtil.mkParentDirs(file);
                        }
                        ImageIO.write(image, type, file);
                        if (file.exists()) {
                            boolean exists = SftpUtils.directoryExists(channelSftp, remotePath);
                            if (!exists) {
                                SftpUtils.mkdirDirs(remotePath, channelSftp);
                            }
                            String remoteFilePath = CommonUtils.removeSeparatorFromSuffix(remotePath).concat(Constants.PAD_LEFT_SLASH).concat(paperId + "_" + (i)).concat(Constants.PAD_DOT).concat(type);
                            channelSftp.put(localPath, remoteFilePath);

                            // 解析完图片同时存放另一版本 到alg_images中 需要算法解析 然后渲染四角坐标
                            boolean algExists = SftpUtils.directoryExists(channelSftp, remoteAlgPath);
                            if (!algExists) {
                                SftpUtils.mkdirDirs(remoteAlgPath, channelSftp);
                            }
                            String remoteAlgFilePath = CommonUtils.removeSeparatorFromSuffix(remoteAlgPath).concat(Constants.PAD_LEFT_SLASH).concat(paperId + "_" + (i)).concat(Constants.PAD_DOT).concat(type);
                            channelSftp.put(localPath, remoteAlgFilePath);

                            // 删除本地图片
                            FileUtil.del(file);
                            log.info("文献 id{} 的第 {} 张 pdf 转 pic 完成，本地临时图片删除成功。", paperId, i);
                        }
                    }

                    pdfAnalysis.setSuccess(true);
                    pdfAnalysis.setPath(path);
                    pdfAnalysis.setFilePath(remotePath);
                    pdfAnalysis.setAlgFilePath(remoteAlgPath);
                    pdfAnalysis.setIpFilePath(ipRemotePath);
                    pdfAnalysis.setIpAlgFilePath(ipAlgRemotePath);
                    pdfAnalysis.setOnePicUrl(CommonUtils.removeSeparatorFromSuffix(ipRemotePath).concat(Constants.PAD_LEFT_SLASH).concat(paperId + "_0." + type));
                    pdfAnalysis.setType(type);
                    pdfAnalysis.setImagesCount(pageCount);
                    mongoTemplate.save(pdfAnalysis);
                    log.info("文献 id {}, pdf 全部转换图片完成，完成时间{}", paperId, new Date().getTime() - begin.getTime());

                } catch (FileNotFoundException e) {
                    pdfAnalysis.setSuccess(false);
                    pdfAnalysis.setAlgSuccess(false);
                    pdfAnalysis.setStatus(2);
                    mongoTemplate.save(pdfAnalysis);
                    log.error("文献 id {}, pdf 转换图片过程中，失败！！！", paperId);
                    log.error(e.getMessage(), e);
                } finally {
                    channelSftp.exit();
                }
            } catch (JSchException | SftpException e) {
                log.error(e.getMessage(), e);
            } catch (IOException e) {
                throw new RuntimeException(e);
            } finally {
                if (jschSession != null) {
                    try {
                        jschSession.disconnect();
                    } catch (Exception e) {
                        log.warn(e.getMessage(), e);
                    }
                }
                
                // 算法分析  线程池解耦  上传完就返回  不阻塞主线程
                if (algAnalysisSuccess) {
                    ALG_EXECUTOR.execute(() -> {
                        // 调用算法 接口 去解析pdf的四角坐标
                        AlgAnalysisBo algAnalysisBo = new AlgAnalysisBo(paperId, questionId, userId, pdfFilePath, "", studyType);
                        applicationEventPublisher.publishEvent(new AlgAnalysisEvent(this, algAnalysisBo));
                    });
                }
            }
        }
    }
}
