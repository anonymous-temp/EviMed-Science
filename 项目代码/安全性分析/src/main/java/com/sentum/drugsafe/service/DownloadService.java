package com.sentum.drugsafe.service;

import com.itextpdf.text.DocumentException;

import javax.servlet.http.HttpServlet;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;
import java.io.IOException;

public interface DownloadService {
    void download(String id, HttpServletResponse response, String source) throws DocumentException, IOException, com.lowagie.text.DocumentException;
    void downloadJd(String id, HttpServletResponse response, String source) throws DocumentException, IOException, com.lowagie.text.DocumentException;
    void guideDownloadPdf(String id, HttpServletResponse response, String source) throws DocumentException, IOException, com.lowagie.text.DocumentException;
    void guideDownloadJdPdf(String id, HttpServletResponse response, String source) throws DocumentException, IOException, com.lowagie.text.DocumentException;
}
